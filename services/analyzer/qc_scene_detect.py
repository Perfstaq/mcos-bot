#!/usr/bin/env python3
"""qc_scene_detect.py — pinned QC harness scene detection (ADR-8 §4.1(c)).

`PySceneDetect ContentDetector(threshold=27)` on a RENDERED mp4 — the exact
configuration the reference reel was independently re-measured with
(reference_measured.json). Used ONLY by `scripts/qc-render.ts` for:

  - G1b (render fidelity, hard gate): does a detected cut exist within ±2
    frames of each of the plan's cut times? (matching against KNOWN cut
    times, never blind re-discovery — that's what made the reference
    oscillate between 0.862/0.821 depending on threshold, ADR-8 §4.1)
  - the informational pixel-derived beat-lock ratio in qc.json, reported
    next to the calibrated 0.821 reference baseline (never gated on)

Deliberately separate from `stages/` (services/analyzer's MediaAnalysis
stages — words/beats implemented, scenes/motion/faces reserved for later
agents): this is QC harness config, pinned and normative per ADR-8, not an
analysis stage whose job is to feed `MediaAnalysis`.

  python qc_scene_detect.py --input <rendered.mp4>
"""
import argparse
import json
import sys

from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector

CONTENT_DETECTOR_THRESHOLD = 27  # ADR-8 §4.1(c) — pinned, change bumps analyzerVersion


def detect_cut_times_ms(input_path: str) -> list[int]:
    """Every shot START except the first, in ms — the t=0 boundary is not a
    cut (ADR-8 §4.1(c))."""
    video = open_video(input_path)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=CONTENT_DETECTOR_THRESHOLD))
    sm.detect_scenes(video, show_progress=False)
    scenes = sm.get_scene_list()
    cut_times_sec = [s.seconds for s, _ in scenes][1:]
    return [int(round(t * 1000)) for t in cut_times_sec]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    args = ap.parse_args()
    try:
        cuts = detect_cut_times_ms(args.input)
    except Exception as e:  # noqa: BLE001 — surfaced as a qc_failed reason, never silent
        print(f"[qc_scene_detect] FAILED: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
    print(json.dumps({"cutTimesMs": cuts}))


if __name__ == "__main__":
    main()
