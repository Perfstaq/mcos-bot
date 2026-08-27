"""beats.py — the canonical beat grid (ARCHITECTURE.md §4, ADR-2).

librosa `beat.beat_track` on the sidecar is the source of truth. This is the
SAME method `scripts/qc-render.ts` measures against (ADR-8 §4.1's pinned
harness): 22050Hz mono, ffmpeg-demuxed WAV (soundfile/librosa cannot open
MP4/MOV directly), default hop 512, `units="time"`. Using one shared grid for
both the planner and QC is the whole point — a two-estimator split is what
made the ported `detectBeats`/`buildBeatGrid` unusable as the gate's ruler
(see M-1/M-4 measurements).

Ladder position 1 of 3 (ARCHITECTURE §4's fallback ladder): `beat_track` is
the production path. `onset_env` (speech-only, no bed) and `constant_grid`
(dev machines without the sidecar) are NOT implemented here — they are the
planner's (Agent M's) fallback, chosen when this stage's output is
unavailable or `grid_quality` is too low, not a mode this CLI runs itself.
"""
from __future__ import annotations

import subprocess
import tempfile
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np
import librosa

SAMPLE_RATE = 22050
HOP_LENGTH = 512


@dataclass
class BeatGrid:
    method: str
    tempo_bpm: Optional[float]
    beat_times_ms: list[int]
    grid_quality: Optional[float]

    def to_dict(self) -> dict:
        # camelCase on the wire — this is copied verbatim into
        # `RenderPlan.plan.beatGrid` (packages/render/src/plan.ts's
        # BeatGridSchema) with no translation layer, per ARCHITECTURE.md §4.1:
        # "Canonical grid = MediaAnalysis.beats, embedded into RenderPlan.plan."
        return {
            "method": self.method,
            "tempoBpm": self.tempo_bpm,
            "beatTimesMs": self.beat_times_ms,
            "gridQuality": self.grid_quality,
        }


def demux_to_wav(input_path: str, out_wav: Optional[str] = None) -> str:
    """ffmpeg-demux `input_path` to mono 22050Hz WAV. librosa/soundfile cannot
    open MP4/MOV containers directly — this is the required first step
    (ARCHITECTURE.md §4.1/ADR-8, doc correction table §10)."""
    if out_wav is None:
        fd, out_wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", input_path,
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            out_wav,
        ],
        check=True,
    )
    return out_wav


def grid_quality(y: np.ndarray, sr: int, beat_times_sec: list[float]) -> Optional[float]:
    """Mean onset-strength at beat times ÷ mean at inter-beat midpoints
    (ARCHITECTURE.md §4.1) — guards a degraded/gamed grid: a real beat lock
    should sit ON energy peaks, not halfway between them. Calibrated on the
    reference, which measures ~86% lock at 112.3 BPM (01_REFERENCE_ANALYSIS §3).
    Returns None when there are too few beats to form a midpoint (e.g. silent
    or beatless audio) — an honest "can't tell", not a fabricated number.
    """
    if len(beat_times_sec) < 2:
        return None
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    midpoints = [(beat_times_sec[i] + beat_times_sec[i + 1]) / 2 for i in range(len(beat_times_sec) - 1)]

    def sample(times: list[float]) -> float:
        frames = librosa.time_to_frames(times, sr=sr, hop_length=HOP_LENGTH)
        frames = np.clip(frames, 0, len(onset_env) - 1)
        return float(np.mean(onset_env[frames])) if len(frames) else 0.0

    at_beats = sample(beat_times_sec)
    at_midpoints = sample(midpoints)
    if at_midpoints <= 0:
        return None
    return round(at_beats / at_midpoints, 4)


def analyze_beats(input_path: str) -> BeatGrid:
    """Full `beats` stage: demux -> beat_track -> grid-quality. Never guesses
    a grid it isn't confident in: `beat_track` itself doesn't fail on
    beatless audio, it just returns a low/degenerate tempo, so grid_quality
    is the honest signal for "don't trust this grid" downstream (the
    planner's job, not this stage's)."""
    wav_path = demux_to_wav(input_path)
    try:
        y, sr = librosa.load(wav_path, sr=SAMPLE_RATE, mono=True)
    finally:
        os.remove(wav_path)

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP_LENGTH, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)
    tempo_bpm = round(float(np.atleast_1d(tempo)[0]), 3) if len(beat_frames) else None
    beat_times_list = [float(t) for t in beat_times]

    return BeatGrid(
        method="beat_track",
        tempo_bpm=tempo_bpm,
        beat_times_ms=[int(round(t * 1000)) for t in beat_times_list],
        grid_quality=grid_quality(y, sr, beat_times_list),
    )
