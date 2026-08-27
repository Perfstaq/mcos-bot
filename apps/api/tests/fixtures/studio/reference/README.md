# Reference reel calibration fixtures

The source is `08f77252a39a4dec9296f15ba4d17865.MP4` — the Raj Shamani podcast
clip `01_REFERENCE_ANALYSIS.md` measures. **The MP4 itself is not committed**
(97MB, and it is someone else's content — 04 §5's retention posture applies to
it exactly as it does in production). Both JSON files here are derived data.

## `reference_measured.json` — the ADR-8 calibration baseline

ADR-8 §4.1(3) requires this committed as a fixture: *"the reference
re-measurement is the calibration baseline … the fingerprint threshold moves
only when the pinned harness re-measures the reference, never independently."*
It was produced by `services/analyzer/measure_reference.py` (committed
alongside, also per ADR-8) and had been living only in a session scratchpad
until now, which is why `04 §6`'s bands kept being read as absolute.

Reproduce with:

```
services/analyzer/.venv/bin/python services/analyzer/measure_reference.py <path-to-reel>
```

**One caveat on the script, and it matters.** `measure_reference.py` compares
cut-to-beat distances as floating-point seconds (`d <= 0.150`). ADR-8 §4.1(c)
pins the comparison as *integer milliseconds, pass at ≤150 inclusive*. The two
rules disagree about the reference — it has a cut sitting within a millisecond
of the window edge — and on this input the float rule happens to land on the
same answer, 23/28. It does so by luck, not by agreeing with the harness:
`stages/beats.py` quantises the grid to integer ms on the wire, and running
the float comparison against that quantised grid scores **0.786**, not 0.821.
`stages/fingerprint.py` implements the pinned integer-ms rule. Treat the
script as the historical record of where 0.821 came from, and the stage as the
normative implementation.

## `fingerprint.json` — the extractor's output on that reel

Produced by the pinned harness:

```
services/analyzer/.venv/bin/python services/analyzer/analyzer.py \
  --input <path-to-reel> --out <dir> --stages fingerprint --asset-id reference-reel
```

`studio-fingerprint.test.ts` asserts this fixture against
`reference_measured.json` — calibration-relative, per ARCHITECTURE §11.3 —
rather than against `04 §6`'s absolute bands, whose floors the reference sits
within one merged shot of. Regenerating it after any change to the extractor
is the point: a diff here is the extractor changing its mind about the one
reel we have ground truth for, and should be read as evidence, not noise.

Reproducing it requires the MP4. `RUN_FINGERPRINT_EXTRACTOR=1` plus
`REFERENCE_REEL_PATH=<path>` makes the test suite re-derive it live and assert
the fixture still matches; without those the suite reads the fixture only, so
CI stays green on a machine that has neither the reel nor a venv.
