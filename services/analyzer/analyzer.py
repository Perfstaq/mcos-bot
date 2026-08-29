#!/usr/bin/env python3
"""analyzer.py — Content Studio media sidecar CLI.

Invoked per-job by `apps/api/src/jobs/media-analyze.ts` via a promisified,
timeout-bounded `execFile` (the same venv-shell pattern founder-journey's
transcribe.ts already runs in production shape — ARCHITECTURE.md §5/ADR-3).
No long-lived Python process, no Python<->Redis client, no HTTP inside the
task: the CLI writes one JSON file per requested stage into --out and
exits; the Node job zod-validates each file before writing it into
`MediaAnalysis`.

  python analyzer.py --input <media> --out <dir> --stages words,beats [--model base] [--language en]
  python analyzer.py --print-versions

Only `words` and `beats` are implemented (Agent P's task 4 scope). `words`
includes per-word RMS energy (ARCHITECTURE §11.1 R1 — 02_MOTION_SYSTEM §3's
emphasis scorer needs it).

`scenes`/`motion`/`faces` are named in the target CLI shape (ARCHITECTURE.md
§2) but are all DEFERRED to v2, per the human's v1 scope ruling
(ARCHITECTURE §11.1 R2): v1 ships `letterbox` framing only (matching the
reference), which puts captions in the black bars and structurally removes
the need for face detection; per-shot footage scoring uses pause quality +
word-RMS + duration fit instead of motion energy; the scrim is a static
per-template policy, not a computed luminance map. `fill` framing (which
would need faces/motion again) is v2's problem, not this milestone's.
Requesting scenes/motion/faces still fails loudly rather than silently
doing nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Node invokes this by absolute path (execFileSync, no fixed cwd — matches
# transcribe.ts's pattern for whisperx_run.py). Make `stages/` importable
# regardless of caller cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ANALYZER_VERSION = "studio-analyzer@0.3.0"  # 0.3.0: fingerprint stage (04_STYLE_TRANSFER §3)

IMPLEMENTED_STAGES = {"words", "beats", "fingerprint"}
# `scenes`/`motion`/`faces` stay reserved. The `fingerprint` stage measures
# shots and motion internally (04_STYLE_TRANSFER §3 needs both), but it emits
# ONE EditFingerprint object for a reference reel — it is not the per-signal
# `MediaAnalysis.scenes`/`.motion` payload those stage names are reserved for,
# and `faces` remains v2's problem with `fill` framing (§11.1 R2).
KNOWN_UNIMPLEMENTED_STAGES = {"scenes", "motion", "faces"}


def eprint(*a: object) -> None:
    print(*a, file=sys.stderr, flush=True)


def library_versions() -> dict:
    import faster_whisper
    import librosa
    import numpy

    return {
        "analyzerVersion": ANALYZER_VERSION,
        "fasterWhisper": getattr(faster_whisper, "__version__", "unknown"),
        "librosa": librosa.__version__,
        "numpy": numpy.__version__,
    }


def run_words(args: argparse.Namespace, out_dir: str) -> None:
    from stages.words import analyze_words

    eprint(f"[analyzer] words: transcribing {args.input} (model={args.model}, {args.device}/{args.compute_type})")
    result = analyze_words(
        args.input,
        model_size=args.model,
        device=args.device,
        compute_type=args.compute_type,
        language=args.language,
    )
    out_path = os.path.join(out_dir, "words.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    n_words = sum(len(s["words"]) for s in result["segments"])
    eprint(f"[analyzer] words: wrote {len(result['segments'])} segments, {n_words} words -> {out_path}")
    if n_words == 0:
        eprint("[analyzer] words: no words transcribed — beat-snap planning will find no word edges to cut on")


def run_beats(args: argparse.Namespace, out_dir: str) -> None:
    from stages.beats import analyze_beats

    eprint(f"[analyzer] beats: analyzing {args.input} (librosa beat_track, {os.path.basename(__file__)})")
    grid = analyze_beats(args.input)
    out_path = os.path.join(out_dir, "beats.json")
    with open(out_path, "w") as f:
        json.dump(grid.to_dict(), f, indent=2)
    eprint(
        f"[analyzer] beats: tempo={grid.tempo_bpm}bpm, {len(grid.beat_times_ms)} beats, "
        f"grid_quality={grid.grid_quality} -> {out_path}"
    )
    if grid.tempo_bpm is None:
        eprint("[analyzer] beats: no clear tempo — grid is empty, beat_method should fall back downstream")


def run_fingerprint(args: argparse.Namespace, out_dir: str) -> None:
    from stages.fingerprint import extract_fingerprint

    eprint(f"[analyzer] fingerprint: analyzing {args.input} (04_STYLE_TRANSFER §3)")
    fp = extract_fingerprint(args.input, source_asset_id=args.asset_id)
    out_path = os.path.join(out_dir, "fingerprint.json")
    with open(out_path, "w") as f:
        json.dump(fp, f, indent=2)

    zeroed = sorted(k for k, v in fp["confidence"].items() if v == 0.0)
    eprint(
        f"[analyzer] fingerprint: {fp['rhythm']['shotCount']} shots / "
        f"{fp['rhythm']['cutCount']} cuts, {fp['rhythm']['cutsPerMin']}/min, "
        f"tempo={fp['audio']['tempoBpm']}, beat_lock={fp['audio']['beatLockRatio']}, "
        f"framing={fp['framing']}, layers={fp['captions']['layers']} -> {out_path}"
    )
    if zeroed:
        # Never silent: a field at confidence 0 is one the mapping will fill
        # from the template default (04 §3), and a reviewer should see which.
        eprint(f"[analyzer] fingerprint: NOT measured (confidence 0, template default applies): {zeroed}")


STAGE_RUNNERS = {
    "words": run_words,
    "beats": run_beats,
    "fingerprint": run_fingerprint,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="media file to analyze (audio or video; any format ffmpeg reads)")
    ap.add_argument("--out", help="output directory — one <stage>.json per requested stage")
    ap.add_argument(
        "--stages",
        default="words,beats",
        help="comma-separated: words,beats,fingerprint (scenes,motion,faces not yet implemented)",
    )
    ap.add_argument("--asset-id", default=None, help="recorded as fingerprint.sourceAssetId")
    ap.add_argument("--model", default="base", help="faster-whisper model size (words stage)")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--language", default=None)
    ap.add_argument("--print-versions", action="store_true", help="print pinned library versions as JSON and exit")
    args = ap.parse_args()

    if args.print_versions:
        print(json.dumps(library_versions(), indent=2))
        return

    if not args.input or not args.out:
        ap.error("--input and --out are required unless --print-versions is given")

    requested = [s.strip() for s in args.stages.split(",") if s.strip()]
    unknown = [s for s in requested if s not in IMPLEMENTED_STAGES and s not in KNOWN_UNIMPLEMENTED_STAGES]
    if unknown:
        raise SystemExit(f"analyzer.py: unknown stage(s): {unknown} (known: {sorted(IMPLEMENTED_STAGES | KNOWN_UNIMPLEMENTED_STAGES)})")
    not_yet = [s for s in requested if s in KNOWN_UNIMPLEMENTED_STAGES]
    if not_yet:
        raise SystemExit(
            f"analyzer.py: stage(s) {not_yet} are named in the target CLI shape but deferred to v2 with "
            "`fill` framing (ARCHITECTURE.md §11.1 R2 — v1 ships letterbox-only). Run only --stages words,beats."
        )

    os.makedirs(args.out, exist_ok=True)
    for stage in requested:
        STAGE_RUNNERS[stage](args, args.out)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — surfaced to the Node job as a failed exit, never silent (03 §7 analyze_failed(reason))
        eprint(f"[analyzer] FAILED: {e}")
        sys.exit(1)
