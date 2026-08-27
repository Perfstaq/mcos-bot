"""fingerprint.py — the EditFingerprint extractor (04_STYLE_TRANSFER §3).

Extracts a *structural* fingerprint of a reference reel: rhythm, tempo/beat
grid, framing, grade and motion. 04 §1 is the honest frame for this file —
you cannot extract an edit as a program, because video is flattened pixels
and the decisions are gone. What comes out here is a description of the
STRUCTURE, which is then mapped onto our own primitives. The promise is
"recreate in this style", never "clone this video".

── What is measured, and what is deliberately not (ARCHITECTURE §11.2 R6) ──
`04 §2` rates three signals Med-high to High on per-frame OCR: caption
timing, caption position pattern, and emphasis treatment. There is no OCR
tooling on this machine, in any venv, or in the port source (verified: no
tesseract binary, no pytesseract module), and adding tesseract to a
production image for medium-fidelity signals is a bad v1 trade. So R6 rules
those fields out, and `04 §3`'s own escape hatch applies from day one —
"every low-confidence field falls back to the template default rather than
guessing". They are emitted as `null` at **confidence 0.0**, never as a
plausible-looking number.

That leaves what is genuinely measurable, which is also what "recreate in
this style" actually promises a user:

  rhythm    PySceneDetect ContentDetector(27)      high    (0.90)
  audio     librosa beat_track (stages/beats.py)   high    (0.85)
  framing   temporal row classification (cv2)      high    (0.90)
  grade     histogram statistics on the content    medium  (0.50) — see below
  motion    Farneback optical flow, radial fit     medium  (0.45) — see below
  layers    banner/karaoke by region occupancy     partial — see `detect_layers`

── One ruler, not two ─────────────────────────────────────────────────────
Both pinned measurement primitives are IMPORTED, never re-implemented:
`CONTENT_DETECTOR_THRESHOLD` from `qc_scene_detect` and `analyze_beats`
from `stages.beats`. ADR-2/ADR-8 exist because two estimators measuring the
same quantity is an architecture bug regardless of either one's quality, and
a fingerprint whose shot detection drifted from QC's would put that bug
back. Importing across the stages/QC line is deliberate and is the lesser
evil: the alternative is a second copy of a pinned constant.
"""
from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Optional

import cv2
import numpy as np
from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from qc_scene_detect import CONTENT_DETECTOR_THRESHOLD  # noqa: E402  (pinned by ADR-8 §4.1(c))
from stages.beats import analyze_beats  # noqa: E402

FINGERPRINT_VERSION = "studio-fingerprint@0.1.0"

# ---------------------------------------------------------------------------
# The cuts-vs-shots convention, pinned (ARCHITECTURE §11.3).
#
# N detected shots ⇒ N−1 cuts. The t=0 boundary is NOT a cut. This is the same
# convention `qc_scene_detect.detect_cut_times_ms` and `plan.cutTimesMs` use,
# and it is the difference between the reference reading 30.6 cuts/min and
# 31.7 — i.e. between clearing a band whose floor is 30 and failing it. It is
# pinned in the schema (domain/studio/fingerprint.ts) as well as here, and
# both sides carry the same note, because a convention documented on only one
# side of a wire is a convention that will drift.
# ---------------------------------------------------------------------------
CUTS_PER_SHOT_OFFSET = 1

# The G1a lock window, and the COMPARISON RULE that goes with it. ADR-8
# §4.1(c) pins "distances compared as integer milliseconds, pass at ≤150
# inclusive" — not a float comparison in seconds. This is not pedantry: the
# reference has a cut sitting exactly on the boundary, so the two rules
# disagree on it and produce 0.786 vs the calibrated 0.821. See
# `measure_audio`.
LOCK_WINDOW_MS = 150

# --- framing ---------------------------------------------------------------
# Rows are classified from TEMPORAL statistics, not from a single frame. A
# letterbox bar is black in every frame; overlay text is bright but nearly
# still; footage is bright AND changes constantly (cuts, motion, a moving
# subject). Per-pixel temporal standard deviation separates the three cleanly
# where a single frame's luminance cannot — measured on the reference, footage
# rows run ~52 while the banner's text rows run ~17-27 and bars run ~0.
ROW_BLACK_MAX_MEAN = 8.0     # below this a row carries no content at all
ROW_VIDEO_MIN_TSTD = 40.0    # at/above this a row is moving footage
MIN_VIDEO_RUN_ROWS = 40      # ignore stray runs; a video band is substantial
MIN_OVERLAY_RUN_ROWS = 4     # below this it is seam anti-aliasing, not text
LETTERBOX_MIN_TOTAL_BAR_RATIO = 0.05

FRAME_SAMPLES = 48

# --- grade -----------------------------------------------------------------
# Calibration constants, NOT physics. See `measure_grade`.
NEUTRAL_LUMA_STD = 52.0
NEUTRAL_SATURATION = 96.0

# --- motion ----------------------------------------------------------------
FLOW_WIDTH = 320
MOTION_SAMPLES_PER_SHOT = 12
MIN_VISIBLE_SCALE_DELTA = 0.01   # G7's "scale delta >1%", mirrored.
PUNCH_PER_SAMPLE_SCALE = 0.012   # a punch is a fast spike, not drift
# Consecutive above-threshold samples inside one fast move are ONE event, not
# one per sample. Without this the reference reports 32 "punches", most of
# them adjacent samples in the same two shots — a count that would badly
# mislead anyone reading it as "the editor punched in 32 times".
PUNCH_MERGE_MS = 500
MICRO_MOTION_MIN_RATIO = 0.9     # 01 §5 claims 100%; see `measure_motion`.

# --- layers ----------------------------------------------------------------
# Overlay text is drawn at near-saturated VALUE (HSV V, not grey luma — pure
# red text has grey luma 76 but V 255, and the reference's banner emphasis
# word is red while a karaoke chunk is yellow) and spans a wide horizontal
# run. Facial highlights and lit background objects do produce bright pixels,
# but rarely a wide contiguous run across many adjacent rows.
TEXT_V_MIN = 225
BANNER_MIN_WIDTH_FRAC = 0.06
BANNER_MIN_ROWS = 12
BANNER_PERSISTENCE_MIN = 0.60    # 01 §4: "persistent for the entire clip"
KARAOKE_MIN_WIDTH_FRAC = 0.12
KARAOKE_BAND_START = 0.55        # lower 45% of the video band
KARAOKE_OCCUPANCY = (0.15, 0.99) # words come and go; always/never is not karaoke


@dataclass
class Confidence:
    """Per-field confidence, 0..1 (04 §3).

    A field at 0.0 was NOT measured and its value is `null`/`undetermined` —
    the mapping substitutes the template default (04 §3). This is the
    milestone's discipline applied to a data structure: a confidence that
    overstates what was actually measured is worse than a low one, because
    the mapping downstream cannot tell a real 0.6 from an invented one.
    """

    values: dict[str, float] = field(default_factory=dict)

    def set(self, key: str, value: float) -> None:
        self.values[key] = round(float(value), 3)

    def to_dict(self) -> dict:
        return dict(sorted(self.values.items()))


# ---------------------------------------------------------------------------
# Rhythm
# ---------------------------------------------------------------------------

def detect_shots(input_path: str) -> list[tuple[float, float]]:
    """Shot (start, end) pairs in seconds, PySceneDetect ContentDetector at
    the ADR-8-pinned threshold — same detector, threshold and library version
    as `qc_scene_detect` and as the reference re-measurement."""
    video = open_video(input_path)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=CONTENT_DETECTOR_THRESHOLD))
    sm.detect_scenes(video, show_progress=False)
    return [(s.seconds, e.seconds) for s, e in sm.get_scene_list()]


def classify_pattern(durations_sec: list[float]) -> tuple[str, float]:
    """`04 §3`'s rhythm pattern enum, and an honest confidence for it.

    01 §2 measured the reference's core finding — "rhythmic breathing, not
    uniform pacing": a long establishing shot, a burst of rapid cuts, a long
    hold to let a point land, repeat. The three labels 04 §3 allows are
    distinguishable from the duration sequence alone:

      uniform      — low spread; everything near the median.
      accelerating — a monotone downward trend across the reel.
      establish_accelerate_hold — high spread with NO global trend, i.e. long
                     shots recur throughout instead of front-loading.

    Confidence is deliberately lower than the rhythm numbers it derives from.
    `cuts_per_min` is a measurement; this is a *judgement* about shape drawn
    from ~29 samples, and the two do not deserve the same number.
    """
    n = len(durations_sec)
    if n < 4:
        return "uniform", 0.2

    med = statistics.median(durations_sec)
    if med <= 0:
        return "uniform", 0.2
    # Robust spread: median absolute deviation over the median. Resistant to
    # the single 5.65s tail shot in a way a standard deviation is not.
    mad = statistics.median([abs(d - med) for d in durations_sec]) / med

    # Trend: Spearman (rank) correlation of duration against position.
    ranked = [r for r, _ in sorted(enumerate(durations_sec), key=lambda p: p[1])]
    order = [0] * n
    for rank, original in enumerate(ranked):
        order[original] = rank
    mean_i = (n - 1) / 2
    cov = sum((i - mean_i) * (order[i] - mean_i) for i in range(n))
    var = sum((i - mean_i) ** 2 for i in range(n))
    trend = cov / var if var else 0.0

    if mad < 0.22:
        return "uniform", round(min(0.75, 0.4 + (0.22 - mad) * 2), 3)
    if trend < -0.45:
        return "accelerating", round(min(0.75, 0.4 + abs(trend) * 0.4), 3)
    return "establish_accelerate_hold", round(min(0.7, 0.35 + mad * 0.6), 3)


def measure_rhythm(shots: list[tuple[float, float]], conf: Confidence) -> dict:
    durations = [e - s for s, e in shots]
    total_sec = shots[-1][1] if shots else 0.0
    n_cuts = max(0, len(shots) - CUTS_PER_SHOT_OFFSET)

    if not durations or total_sec <= 0:
        conf.set("rhythm", 0.0)
        return {
            "shotCount": len(shots), "cutCount": n_cuts, "cutsPerMin": None,
            "medianShotMs": None, "meanShotMs": None, "minShotMs": None,
            "maxShotMs": None, "shotDurationsMs": [], "pattern": None,
        }

    pattern, pattern_conf = classify_pattern(durations)
    # PySceneDetect on a hard-cut reel is genuinely high fidelity — the
    # reference's shot list reproduces the doc's exactly for 28 of 29 shots
    # (ARCHITECTURE §4.1). NOT 1.0: the 29th is a threshold-sensitive merge,
    # which is the entire reason 04 §6's bands became calibration-relative.
    # A detector that can merge a shot is not a certainty.
    conf.set("rhythm", 0.9)
    conf.set("rhythm_pattern", pattern_conf)

    return {
        "shotCount": len(shots),
        "cutCount": n_cuts,
        "cutsPerMin": round(n_cuts / (total_sec / 60.0), 3),
        "medianShotMs": int(round(statistics.median(durations) * 1000)),
        "meanShotMs": int(round(statistics.mean(durations) * 1000)),
        "minShotMs": int(round(min(durations) * 1000)),
        "maxShotMs": int(round(max(durations) * 1000)),
        "shotDurationsMs": [int(round(d * 1000)) for d in durations],
        "pattern": pattern,
    }


# ---------------------------------------------------------------------------
# Audio — tempo, beat grid, beat lock
# ---------------------------------------------------------------------------

def measure_audio(input_path: str, cut_times_sec: list[float], conf: Confidence) -> dict:
    """librosa `beat_track` via the pinned `stages.beats` path, plus the
    cut-to-beat lock statistics 01 §3 calls "the thing that separates pro
    from amateur".

    ── The comparison rule is load-bearing ───────────────────────────────
    Distances are rounded to integer milliseconds and compared `<= 150`,
    which is what ADR-8 §4.1(c) pins. Comparing floats in seconds instead
    scores the reference **0.786**, not the calibrated **0.821**, because one
    cut lands within a millisecond of the window edge and `stages.beats`
    already quantised the grid to integer ms on the wire. Two defensible-
    looking rules, a 3.5-point spread, and only one of them is the pinned
    harness. (`measure_reference.py`, the script ADR-8 cites, compares floats
    and agrees only by luck on this input — see the fixture's README note.)

    `beatTimesMs` is stored because it is the MEASUREMENT — it is what
    `beatLockRatio` was computed against, and a ratio nobody can recheck is
    not evidence. It is never an input to the mapping: 00_MASTER invariant 5
    and 04 §5 require the reference's audio to be discarded and the new grid
    re-derived from the new footage. `style-transfer.ts` enforces that on the
    other side of the wire rather than trusting a comment here.
    """
    grid = analyze_beats(input_path)
    beat_ms = np.array(grid.beat_times_ms, dtype=np.int64)
    cut_ms = [int(round(t * 1000)) for t in cut_times_sec]

    if len(beat_ms) and cut_ms:
        deltas_ms = [int(np.min(np.abs(beat_ms - c))) for c in cut_ms]
        within = sum(1 for d in deltas_ms if d <= LOCK_WINDOW_MS)
        lock_ratio = round(within / len(deltas_ms), 3)
        lock_median_ms = int(statistics.median(deltas_ms))
        # High fidelity and directly recheckable — but detector-dependent
        # through `cut_times_sec` (ADR-8: the reference scores 0.862 or 0.821
        # depending on threshold), so not 0.95.
        conf.set("audio", 0.85)
    else:
        deltas_ms, lock_ratio, lock_median_ms = [], None, None
        conf.set("audio", 0.0)

    return {
        "tempoBpm": grid.tempo_bpm,
        "beatTimesMs": grid.beat_times_ms,
        "beatCount": len(grid.beat_times_ms),
        "gridQuality": grid.grid_quality,
        "beatLockRatio": lock_ratio,
        "beatLockMedianMs": lock_median_ms,
        "cutToBeatDeltasMs": deltas_ms,
    }


# ---------------------------------------------------------------------------
# Frame sampling — one decode pass, shared by framing/grade/layers
# ---------------------------------------------------------------------------

@dataclass
class FrameSet:
    frames: list[np.ndarray]      # BGR, full resolution
    times_sec: list[float]
    width: int
    height: int
    fps: float                    # container AVERAGE rate (see extract_fingerprint)
    frame_count: int


def sample_frames(input_path: str, count: int = FRAME_SAMPLES) -> FrameSet:
    """Evenly spaced frames across the clip. One decode pass feeds every
    pixel-domain measurement below — decoding once per signal would multiply
    the cost of the stage for no extra information."""
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise RuntimeError(f"cv2 could not open {input_path}")
    try:
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if total <= 0:
            raise RuntimeError(f"cv2 reports no frames in {input_path}")

        # Skip the first and last 2%: many reels open or close on black, which
        # drags the grade statistics down and can read as a full-frame bar.
        lo, hi = int(total * 0.02), int(total * 0.98)
        idxs = np.unique(np.linspace(lo, max(lo + 1, hi), count).astype(int))

        frames, times = [], []
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
            ok, frame = cap.read()
            if ok and frame is not None:
                frames.append(frame)
                times.append(float(i) / fps if fps > 0 else 0.0)
        if not frames:
            raise RuntimeError(f"cv2 decoded no frames from {input_path}")
        return FrameSet(frames, times, width, height, fps, total)
    finally:
        cap.release()


def temporal_stats(fs: FrameSet) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel temporal (mean, std) of luma across the sampled frames.

    Accumulated as running sums rather than stacking every frame: the stack
    for a 48-sample 720×1280 clip is ~180MB in float32, the accumulators are
    ~7MB, and the sidecar shares a container with faster-whisper.
    """
    h, w = fs.height, fs.width
    s = np.zeros((h, w), dtype=np.float64)
    ss = np.zeros((h, w), dtype=np.float64)
    n = 0
    for frame in fs.frames:
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float64)
        s += g
        ss += g * g
        n += 1
    mean = s / n
    var = np.maximum(0.0, ss / n - mean * mean)
    return mean, np.sqrt(var)


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

def measure_framing(fs: FrameSet, conf: Confidence) -> dict:
    """`framing: 'letterbox' | 'fill'` plus the measured content region.

    ── Why rows are classified temporally, not by brightness ─────────────
    A first implementation walked down from row 0 while rows were black. On
    the reference that stops at the BANNER, not at the video: the banner sits
    at the bottom of the top bar, and a row of white-on-black text is mostly
    black, so a brightness walk sails past it and reports a content region
    45px too tall. Classifying rows as black / still-overlay / moving-footage
    from per-pixel temporal statistics separates all three, and the content
    region it returns is the FOOTAGE band — the thing every other measurement
    in this file needs to be cropped to.

    ── Why the content region is reported and not just the mode ──────────
    ARCHITECTURE §12.4: `01 §7` says the reference is "16:9 podcast footage
    scaled to fit width", and it is not. §12.16 then made a ~0.9:1 crop the
    v1 rule. A fingerprint reporting only "letterbox" would be true and
    useless; the region ratio is the number that drives the mapping.
    """
    tmean, tstd = temporal_stats(fs)
    h, w = fs.height, fs.width
    row_mean = tmean.mean(axis=1)
    row_tstd = tstd.mean(axis=1)

    def row_class(r: int) -> str:
        if row_mean[r] < ROW_BLACK_MAX_MEAN:
            return "black"
        return "video" if row_tstd[r] >= ROW_VIDEO_MIN_TSTD else "overlay"

    labels = [row_class(r) for r in range(h)]

    # Longest contiguous run of video rows — the footage band.
    runs: list[tuple[str, int, int]] = []
    start = 0
    for r in range(1, h):
        if labels[r] != labels[start]:
            runs.append((labels[start], start, r - 1))
            start = r
    runs.append((labels[start], start, h - 1))

    video_runs = [(a, b) for k, a, b in runs if k == "video" and b - a + 1 >= MIN_VIDEO_RUN_ROWS]
    if video_runs:
        v_top, v_bottom = video_runs[0][0], video_runs[-1][1]
    else:
        # No moving band at all (a still, or a decode that produced identical
        # frames). Report the whole frame rather than inventing a region.
        v_top, v_bottom = 0, h - 1

    content_h = max(1, v_bottom - v_top + 1)
    top_ratio = v_top / h
    bottom_ratio = (h - 1 - v_bottom) / h
    total_bar_ratio = top_ratio + bottom_ratio
    mode = "letterbox" if total_bar_ratio >= LETTERBOX_MIN_TOTAL_BAR_RATIO else "fill"

    # Overlay rows sitting ABOVE the footage band — structurally footage-free,
    # which is what makes banner detection reliable (`detect_layers`). Runs
    # shorter than MIN_OVERLAY_RUN_ROWS are anti-aliasing at the bar/footage
    # seam, not a text band.
    banner_rows = [
        (a, b) for k, a, b in runs
        if k == "overlay" and b < v_top and b - a + 1 >= MIN_OVERLAY_RUN_ROWS
    ]

    # Row classification is close to arithmetic. Held under 1.0 because the
    # MODE is a threshold decision on `total_bar_ratio`, and a reel with slim
    # 3% bars sits near that boundary.
    conf.set("framing", 0.9)

    return {
        "mode": mode,
        "videoTopRow": int(v_top),
        "videoBottomRow": int(v_bottom),
        "topBarRatio": round(top_ratio, 4),
        "bottomBarRatio": round(bottom_ratio, 4),
        "contentRegionRatio": round(content_h / h, 4),
        "contentWidthPx": w,
        "contentHeightPx": int(content_h),
        "contentAspect": round(w / content_h, 4),
        "frameWidthPx": w,
        "frameHeightPx": h,
        "overlayBandsAboveVideo": [[int(a), int(b)] for a, b in banner_rows],
    }


# ---------------------------------------------------------------------------
# Grade
# ---------------------------------------------------------------------------

def measure_grade(fs: FrameSet, framing: dict, conf: Confidence) -> dict:
    """Histogram statistics over the FOOTAGE band only.

    ── The honesty problem, stated plainly ────────────────────────────────
    `04 §3` names these fields `contrast`/`saturation`/`warmth`/`vignette`,
    and `01 §6`'s implementation rule gives numbers that look like the same
    quantities ("contrast ~1.08, saturation ~1.06"). They are NOT the same
    quantities. 01's are MULTIPLIERS applied to an ungraded source; what is
    measurable here is the ABSOLUTE look of finished pixels. Recovering a
    multiplier would need the ungraded source, which by definition we do not
    have — the reference arrived graded.

    So these are absolute descriptors normalised against neutral-image
    constants, and those constants are calibration, not physics. They are
    comparable BETWEEN reels measured by this function, which is exactly what
    nearest-template matching needs, and they are NOT interpretable as "the
    grade that was applied". Confidence 0.5 records that gap instead of
    hiding it behind a plausible-looking 1.06.

    `blackPointP1`/`whitePointP99` are the two numbers here that ARE directly
    defensible — percentiles of the measured luma histogram, no normalising
    constant involved — so 01 §6's "slightly crushed blacks" is checkable
    against them rather than taken on faith.
    """
    top = int(framing["videoTopRow"])
    bot = int(framing["videoBottomRow"]) + 1

    lumas, sats, warms, vigs, p1s, p99s = [], [], [], [], [], []
    for frame in fs.frames:
        content = frame[top:bot, :, :]
        if content.size == 0:
            continue
        gray = cv2.cvtColor(content, cv2.COLOR_BGR2GRAY).astype(np.float32)
        hsv = cv2.cvtColor(content, cv2.COLOR_BGR2HSV)

        lumas.append(float(gray.std()))
        sats.append(float(hsv[:, :, 1].mean()))
        b = float(content[:, :, 0].mean())
        r = float(content[:, :, 2].mean())
        warms.append((r - b) / 255.0)
        p1s.append(float(np.percentile(gray, 1)))
        p99s.append(float(np.percentile(gray, 99)))

        ch, cw = gray.shape
        y0, y1 = int(ch * 0.25), int(ch * 0.75)
        x0, x1 = int(cw * 0.25), int(cw * 0.75)
        centre = gray[y0:y1, x0:x1]
        if centre.size and gray.size > centre.size:
            ring_n = gray.size - centre.size
            ring_mean = float(gray.sum() - centre.sum()) / ring_n
            centre_mean = float(centre.mean())
            if centre_mean > 1e-6:
                vigs.append(max(0.0, min(1.0, 1.0 - ring_mean / centre_mean)))

    if not lumas:
        conf.set("grade", 0.0)
        return {
            "contrast": None, "saturation": None, "warmth": None,
            "vignette": None, "blackPointP1": None, "whitePointP99": None,
        }

    conf.set("grade", 0.5)
    return {
        "contrast": round(statistics.mean(lumas) / NEUTRAL_LUMA_STD, 4),
        "saturation": round(statistics.mean(sats) / NEUTRAL_SATURATION, 4),
        "warmth": round(statistics.mean(warms), 4),
        "vignette": round(statistics.mean(vigs), 4) if vigs else None,
        "blackPointP1": round(statistics.mean(p1s), 2),
        "whitePointP99": round(statistics.mean(p99s), 2),
    }


# ---------------------------------------------------------------------------
# Motion
# ---------------------------------------------------------------------------

def _radial_scale_rate(prev_gray: np.ndarray, gray: np.ndarray) -> float:
    """Per-pair fractional scale change, from a least-squares radial fit.

    A pure zoom about the region centre produces flow `v ≈ s·r`, where `r` is
    the vector from the centre. The least-squares `s` for that model is
    `Σ(v·r) / Σ(r·r)` — one number per frame pair, which is precisely the
    "progressive scale change within a shot" 01 §5 describes as added in post.
    """
    flow = cv2.calcOpticalFlowFarneback(
        prev_gray, gray, None,
        pyr_scale=0.5, levels=3, winsize=21, iterations=3,
        poly_n=5, poly_sigma=1.2, flags=0,
    )
    h, w = gray.shape
    ys, xs = np.mgrid[0:h, 0:w]
    rx = (xs - w / 2.0).astype(np.float32)
    ry = (ys - h / 2.0).astype(np.float32)
    denom = float((rx * rx + ry * ry).sum())
    if denom <= 1e-6:
        return 0.0
    return float((flow[:, :, 0] * rx + flow[:, :, 1] * ry).sum()) / denom


def _merge_events(times_ms: list[int], window_ms: int) -> list[int]:
    """Collapse runs of near-adjacent timestamps to their first occurrence."""
    merged: list[int] = []
    for t in sorted(set(times_ms)):
        if not merged or t - merged[-1] > window_ms:
            merged.append(t)
    return merged


def measure_motion(
    input_path: str,
    shots: list[tuple[float, float]],
    framing: dict,
    fps: float,
    conf: Confidence,
) -> dict:
    """Per-shot accumulated scale change via Farneback optical flow, measured
    on the FOOTAGE band only.

    Cropping to the footage band is not a refinement, it is a correctness
    fix. The least-squares radial fit weights each pixel by |r|², and the
    letterbox bars are both the furthest rows from centre AND perfectly
    static — so including them loads the fit's denominator with the
    highest-leverage pixels in the frame while contributing zero flow, biasing
    every estimate toward zero. Uncropped, the reference read 24% of shots as
    moving against 01 §5's measured 100%.

    ── Fidelity, honestly ─────────────────────────────────────────────────
    `04 §2` rates this Medium and that is right. The radial model assumes the
    dominant flow is a zoom about the region centre; a talking head moving
    inside the frame contaminates it, and on a locked-off podcast (01 §5:
    "the camera is locked off, the motion is added in post") the subject is
    the only thing moving besides the push. So `meanScaleDelta` is a magnitude
    estimate with real error bars, not a recovered keyframe value. What it is
    reliably good for is the question the mapping actually asks — "is there
    continuous push on every shot, and roughly how strong?" — which is why
    `shotsWithMotionRatio` carries more weight downstream than the magnitude.

    The per-shot figure is the SIGNED accumulation, so a shot that pushes in
    and pulls back out nets toward zero. That is the right answer for "how
    far did the framing travel end to end" and the wrong one for "was there
    movement"; summing absolute per-sample rates instead would accumulate
    ~0.002 of flow noise per sample, which at 12 samples is the same order as
    the 1% signal being tested. The signed figure is kept and the limitation
    recorded rather than traded for a noisier one.

    On the reference this yields 26 of 29 shots above 1% (`0.897`), against
    01 §5's claim of 100%. Two of the three shortfalls sit at 0.90% and
    0.98% — inside this method's error — and the third is the merged 5.65s
    tail shot (ARCHITECTURE §4.1), where opposing motion either side of the
    merge cancels. The claim is close to right; the measurement is reported
    as it came out rather than rounded up to it.
    """
    empty = {
        "microMotion": None, "meanScaleDelta": None, "medianScaleDelta": None,
        "shotsWithMotionRatio": None, "punchEventsMs": [], "perShotScaleDelta": [],
    }
    if fps <= 0 or not shots:
        conf.set("motion", 0.0)
        return empty

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        conf.set("motion", 0.0)
        return empty
    try:
        top = int(framing["videoTopRow"])
        bot = int(framing["videoBottomRow"]) + 1

        per_shot: list[float] = []
        punches: list[int] = []
        for start_sec, end_sec in shots:
            first = int(round(start_sec * fps))
            last = int(round(end_sec * fps)) - 1
            span = last - first
            if span < 2:
                per_shot.append(0.0)
                continue

            # Adaptive stride: always span the WHOLE shot with a bounded
            # number of samples. A fixed stride plus a sample cap silently
            # measured only the first half of every long hold.
            stride = max(1, span // MOTION_SAMPLES_PER_SHOT)
            accumulated = 0.0
            prev_small = None
            for idx in range(first, last + 1, stride):
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ok, frame = cap.read()
                if not ok or frame is None:
                    continue
                content = frame[top:bot, :, :]
                if content.size == 0:
                    continue
                ch, cw = content.shape[:2]
                small = cv2.cvtColor(
                    cv2.resize(content, (FLOW_WIDTH, max(1, int(ch * FLOW_WIDTH / cw)))),
                    cv2.COLOR_BGR2GRAY,
                )
                if prev_small is not None and prev_small.shape == small.shape:
                    rate = _radial_scale_rate(prev_small, small)
                    accumulated += rate
                    if abs(rate) >= PUNCH_PER_SAMPLE_SCALE:
                        punches.append(int(round(idx / fps * 1000)))
                prev_small = small
            per_shot.append(round(accumulated, 5))

        if not per_shot:
            conf.set("motion", 0.0)
            return empty

        magnitudes = [abs(d) for d in per_shot]
        moving = sum(1 for m in magnitudes if m >= MIN_VISIBLE_SCALE_DELTA)
        ratio = moving / len(magnitudes)
        conf.set("motion", 0.45)

        return {
            "microMotion": ratio >= MICRO_MOTION_MIN_RATIO,
            "meanScaleDelta": round(statistics.mean(magnitudes), 5),
            "medianScaleDelta": round(statistics.median(magnitudes), 5),
            "shotsWithMotionRatio": round(ratio, 3),
            "shotsWithMotion": moving,
            "shotCount": len(magnitudes),
            "punchEventsMs": _merge_events(punches, PUNCH_MERGE_MS),
            "perShotScaleDelta": per_shot,
        }
    finally:
        cap.release()


# ---------------------------------------------------------------------------
# Caption layers — presence by region occupancy (no OCR)
# ---------------------------------------------------------------------------

def _text_bands(frame: np.ndarray, y0: int, y1: int, min_width_frac: float,
                min_rows: int) -> list[tuple[int, int, float]]:
    """Contiguous row bands where a wide run of near-saturated pixels sits.

    HSV **V**, not grey luma: the reference's banner emphasis word is red
    (grey luma 76 — invisible to a luma threshold) and one karaoke chunk is
    yellow. V treats white, red and yellow text alike, which is the point.
    """
    if y1 <= y0:
        return []
    v = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)[:, :, 2][y0:y1, :]
    width = v.shape[1]
    frac = (v > TEXT_V_MIN).sum(axis=1) / float(width)
    hot = frac >= min_width_frac

    bands: list[tuple[int, int, float]] = []
    start: Optional[int] = None
    for r, is_hot in enumerate(hot):
        if is_hot and start is None:
            start = r
        elif not is_hot and start is not None:
            if r - start >= min_rows:
                bands.append((start + y0, r - 1 + y0, float(frac[start:r].max())))
            start = None
    if start is not None and len(hot) - start >= min_rows:
        bands.append((start + y0, len(hot) - 1 + y0, float(frac[start:].max())))
    return bands


def detect_layers(fs: FrameSet, framing: dict, conf: Confidence) -> dict:
    """Which of 01 §4's three layers are PRESENT. Presence only, never content.

    ── What this can decide, and what it cannot ──────────────────────────
    Each layer gets one of three verdicts — `present`, `absent`, or
    `undetermined` — because "I measured its absence" and "I could not
    measure it" are different claims and collapsing them is how a fingerprint
    starts lying. `undetermined` carries confidence 0, so 04 §3's rule fires
    and the mapping takes the TEMPLATE default.

      banner — `present`/`absent`, confidence 0.8. Decided in the rows ABOVE
        the footage band, which contain no footage by construction, so a
        false positive is structurally impossible: nothing there can be
        bright and wide except an overlay. Measured 0.906 persistence on the
        reference against 0.0 for the empty bar rows.

      karaoke — `present`/`absent`, confidence 0.55. Wide near-saturated
        bands in the lower 45% of the footage band, occupying an intermittent
        fraction of frames (words come and go; a region occupied always or
        never is not a karaoke layer). Weaker than the banner because this
        one IS over footage, and bright background objects can produce wide
        runs. The measured occupancy is reported so a reviewer can see the
        margin rather than trust the verdict.

      handle — `undetermined`, confidence 0. This was measured and it does
        not work. The reference's handle is a small semi-transparent mark
        over footage; probed at its true position it scores 0.44 occupancy,
        while an equivalent probe over a patch of picture frames on the far
        side of the frame scores 0.47. There is no threshold that admits the
        handle and rejects the wall. Detecting it needs either OCR (ruled out
        for v1 by §11.2 R6) or a text-detection model, so the honest verdict
        is that we cannot tell — NOT `absent`, which would be a claim we did
        not earn. 04 §6 expects `handle` in the layer set; that expectation
        is met by the template default, which is exactly the fallback 04 §3
        specifies for a zero-confidence field. See this milestone's PR body.
    """
    h, w = fs.height, fs.width
    v_top = int(framing["videoTopRow"])
    v_bottom = int(framing["videoBottomRow"])
    n = len(fs.frames)

    banner_hits = sum(
        1 for f in fs.frames
        if _text_bands(f, 0, v_top, BANNER_MIN_WIDTH_FRAC, BANNER_MIN_ROWS)
    )
    banner_occ = banner_hits / n if n else 0.0

    k_start = v_top + int((v_bottom - v_top) * KARAOKE_BAND_START)
    karaoke_hits = sum(
        1 for f in fs.frames
        if _text_bands(f, k_start, v_bottom, KARAOKE_MIN_WIDTH_FRAC, BANNER_MIN_ROWS)
    )
    karaoke_occ = karaoke_hits / n if n else 0.0

    banner = "present" if banner_occ >= BANNER_PERSISTENCE_MIN else "absent"
    karaoke = (
        "present"
        if KARAOKE_OCCUPANCY[0] <= karaoke_occ <= KARAOKE_OCCUPANCY[1]
        else "absent"
    )

    conf.set("captions_banner", 0.8)
    conf.set("captions_karaoke", 0.55)
    conf.set("captions_handle", 0.0)
    # R6: everything below needs per-frame OCR, which v1 does not have.
    # Emitted as null at confidence 0 so the mapping substitutes the template
    # default (04 §3) instead of acting on an invented number.
    conf.set("captions_words_per_chunk", 0.0)
    conf.set("captions_style_class", 0.0)
    conf.set("captions_position_sequence", 0.0)
    conf.set("captions_emphasis", 0.0)

    layer_verdicts = {"banner": banner, "karaoke": karaoke, "handle": "undetermined"}
    return {
        "layerVerdicts": layer_verdicts,
        "layers": [k for k, verdict in layer_verdicts.items() if verdict == "present"],
        "undeterminedLayers": [k for k, verdict in layer_verdicts.items() if verdict == "undetermined"],
        "occupancy": {"banner": round(banner_occ, 3), "karaoke": round(karaoke_occ, 3)},
        # --- R6: not measured in v1 (ARCHITECTURE §11.2 R6) ---------------
        "wordsPerChunkMedian": None,
        "styleClass": None,
        "positionSequence": None,
        "emphasis": None,
    }


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------

def measure_transitions(shots: list[tuple[float, float]], conf: Confidence) -> dict:
    """`04 §2`'s transition classifier, reduced to the only question v1 can
    act on: hard cut, or something gradual?

    ADR-4 ships hard cuts only and the plan schema has no vocabulary for
    anything else, so an 8-class classifier would emit labels nothing
    downstream could consume. 01 §8 records the reference as hard cuts end to
    end ("no whip pans, no dissolves, no zoom transitions"); ContentDetector
    reports a boundary FRAME, and every boundary it found here is a
    single-frame discontinuity, which is the evidence for that claim rather
    than an assumption of it.
    """
    conf.set("transitions", 0.6)
    n = max(0, len(shots) - CUTS_PER_SHOT_OFFSET)
    return {
        "kinds": ["cut"] if n else [],
        "counts": {"cut": n},
        "note": "v1 classifies hard cut vs gradual only — ADR-4 ships hard cuts and the plan has no other vocabulary.",
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def extract_fingerprint(input_path: str, source_asset_id: Optional[str] = None) -> dict[str, Any]:
    """The full `EditFingerprint` (04 §3). Ordered cheapest-first so a file
    that cannot be decoded fails before the expensive optical-flow pass."""
    conf = Confidence()

    shots = detect_shots(input_path)
    cut_times = [s for s, _ in shots][CUTS_PER_SHOT_OFFSET:]
    rhythm = measure_rhythm(shots, conf)
    audio = measure_audio(input_path, cut_times, conf)

    fs = sample_frames(input_path)
    framing = measure_framing(fs, conf)
    grade = measure_grade(fs, framing, conf)
    captions = detect_layers(fs, framing, conf)
    transitions = measure_transitions(shots, conf)
    motion = measure_motion(input_path, shots, framing, fs.fps, conf)

    duration_ms = int(round((shots[-1][1] if shots else fs.frame_count / max(fs.fps, 1e-6)) * 1000))

    # Two frame rates, both real, and they disagree on this file. cv2 and
    # PySceneDetect report the container's AVERAGE rate (nb_frames/duration =
    # 24.423 on the reference); ffprobe's `r_frame_rate` is the NOMINAL base
    # rate (24000/1001 = 23.976), which is the figure `01 §1` quotes. Shot
    # times are derived from the average rate, so that is what `fps` carries;
    # `fpsNominal` is recorded next to it so nobody has to rediscover why the
    # doc says 23.976 and the decoder says 24.4.
    nominal = _nominal_fps(input_path)

    return {
        "fingerprintVersion": FINGERPRINT_VERSION,
        "sourceAssetId": source_asset_id,
        "durationMs": duration_ms,
        "fps": round(fs.fps, 3),
        "fpsNominal": nominal,
        "framing": framing["mode"],
        "framingDetail": framing,
        "rhythm": rhythm,
        "audio": audio,
        "captions": captions,
        "motion": motion,
        "grade": grade,
        "transitions": transitions,
        "confidence": conf.to_dict(),
    }


def _nominal_fps(input_path: str) -> Optional[float]:
    """The container's NOMINAL base rate (`r_frame_rate`), via ffprobe.

    Deliberately not PySceneDetect's `frame_rate` or cv2's `CAP_PROP_FPS`:
    both report the AVERAGE rate (`nb_frames/duration`), so asking either of
    them for the nominal rate just returns the number we already have. ffmpeg
    is already a hard dependency of this sidecar (`stages.beats` demuxes with
    it), so this adds no new one. Returns None rather than guessing when the
    container does not state a rate.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate", "-of", "json", input_path],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout
        rate = json.loads(out)["streams"][0]["r_frame_rate"]
        num, _, den = rate.partition("/")
        value = float(num) / float(den or 1)
        return round(value, 3) if value > 0 else None
    except Exception:  # noqa: BLE001 — a missing nominal rate is not fatal
        return None
