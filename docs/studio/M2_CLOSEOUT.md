# Milestone 2 — Content Studio, closeout

**Approved Living Positioning Brief → human-gated ContentBrief → beat-locked plan → rendered reel.**

733 tests passing, 1 skipped, typecheck clean. Milestone 1 shipped to production at `87165c3`
during this closeout; M2 is this PR.

The authoritative record is `ARCHITECTURE.md` — 49 sections of corrections and rulings, most of them
produced by rendering something and looking at it. **The original eight spec docs are not safe to
read alone**; where they contradict ARCHITECTURE, they are superseded.

---

## What shipped

| Workstream | Delivered |
|---|---|
| **P** pipeline | `packages/render` with Remotion contained by a source-scan test; Python analyzer sidecar (faster-whisper word timings + per-word RMS, librosa beat grids); five additive models; five BullMQ queues; `scripts/qc-render.ts` |
| **M** motion | House springs with mandatory duration rescaling; three-layer caption engine; emphasis scorer; the beat-locked DP planner |
| **B** brief | ContentBrief + its own append-only gate with a source-scan guard; deterministic framework catalogue; OpenAI structured-output generation; parallel review queue |
| **T** templates | Statement / Staccato / Editorial; embedded OFL type; the evidence harness |
| **F** style transfer | `EditFingerprint` extraction; fingerprint→plan mapping; acceptance against a committed calibration baseline |
| **I** integration | `plan.build` and `render.submit` — the chain's missing middle |
| **Closeout** | Reference-reel retention purge; G1b resolved; `plan_infeasible` given a durable surface; the comparison test |

### The headline result

`02_MOTION_SYSTEM` §5 specifies *draw a rhythm curve, then snap each cut to the nearest beat*.
Measured on six real clips with a perfect grid, that algorithm is **structurally marginal** — mean
89.4% beat-lock, worst clip **82.05%**, under the 85% gate. Worse, its cut lists were never valid:
they contained 1–4 mid-word cuts and 7–16 sub-0.6s shots, because the fallback silently returned
illegal cuts when it gave up.

Replaced with a **DP over candidate word-edge boundaries**, scoring beat distance, rhythm deviation
and pause quality under the shot-length bound: **100% beat-lock on all six clips, at every seed and
every tempo** — the tempo sensitivity disappears entirely. On the real render, 29 of 29 cuts land on
the beat against a grid where the human editor who cut the reference scores 82.1%.

It also overturned its own premise: **cutting only on silences is infeasible, not conservative.**
Real speech does not contain silences often enough — the reference proves it with 30 shots in 55
seconds of podcast, and one test clip goes 21.6 seconds between silences against a 5-second maximum
shot.

### The comparison test

`07 §3` asks whether a stranger could immediately pick our render as the professional one.
**PerfStaq PASS ×3, naive baseline FAIL ×3** on identical footage and an identical ContentBrief.

The baseline was built to resist flattering us, in two ways nobody asked for: its shots **declare** a
null camera rather than omitting motion, because omitting it makes the micro-motion gate report
*not computable* and an excluded gate would flatter the baseline by dropping the one gate measuring
what it lacks; and its block captions carry **real words**, because the caption-density gate counts
words and a sentence collapsed into one token would report 1 and pass. Typography was held identical
so the comparison could not be won on fonts.

---

## What was descoped, and why

- **Letterbox framing only.** `fill` mode is deferred with face detection. v1 crops to the
  reference's ~0.9:1 content region (§12.16) and captions live in the bars (§12.43).
- **OCR-dependent signals at confidence 0.** Three of style transfer's twelve signals — caption
  timing, position pattern, emphasis treatment — need OCR that exists nowhere in the stack. `04 §3`
  already specified the behaviour: low-confidence fields fall back to template defaults. Applied
  from day one rather than faked (§11.2 R6).
- **Grade is not mapped at all**, and not for a precision reason: the fingerprint measures absolute
  finished pixels while a template's grade is multipliers over an ungraded source. Assigning one to
  the other is arithmetic on incompatible units. Only warmth *order* is used, in selection (§12.31).
- **`scenes` / `motion` / `faces` analyzer stages.** Descoped by shipping what the reference does:
  letterbox captions structurally cannot occlude a face, so no detector is needed (§11.1 R2 — whose
  stated reason was later found wrong even though its conclusion survived, §12.16).
- **Remotion Lambda.** `render.submit` fails by name rather than silently falling back to local.

---

## The five defects invisible to typechecks and tests

Every one surfaced only because something real ran, or someone looked at a frame:

1. **A caption rendered across a subject's mouth.** Two individually plausible rules — a taller
   content region leaves room below the face; the camera may zoom — composed into an obviously bad
   frame (§12.16).
2. **A plan locked to a beat grid that did not exist.** Sweeping bed phase against a grid derived
   from the *footage's own audio* scored 100% in the planner and 29.2% in QC. Silent and total
   (§12.1).
3. **The production media image could not run the job it existed for.** `tsx` was pruned as a dev
   dependency and `scripts/` was never copied into the runtime stage. Typechecks passed throughout.
4. **The gate was defeatable by timing.** Approval was checked at enqueue while undo only counted
   *materialised* plans, so approve → queue → undo → run would have built a plan from an unapproved
   brief (§12.12a). And the fix's first form did not work either: `requireApprovedContentBrief` reads
   through the module-level client, so calling it lexically inside a transaction still runs **on a
   different connection**. A row lock is the mechanism (§12.24).
5. **Text measured against the wrong casing.** Widths were taken from the plan's stored text while
   the renderer draws karaoke uppercase — capitals are 20–35% wider — so the margin check, the
   wrapped line *count*, and every block height derived from it were all short together. **Every
   check agreed with every other check and all were wrong together** (§12.45).

That last shape recurred three times (§12.34, §12.45, §12.49) and is now named: **when a value is
derived independently on both sides of a boundary, the checks agree with each other and disagree
with reality.** Put the value in the artifact that crosses the boundary, and measure the artifact.

### And one that only a person could have caught

The retention purge required a *succeeded analysis carrying a fingerprint*. The intent was right —
do not delete a video before extracting from it — but the effect inverted the policy: a reference
whose analysis permanently failed satisfied that condition **never**, and so was kept forever. The
privacy posture applies **most** to a video that yielded nothing, because there is no retained
artifact justifying holding it (§12.39).

---

## M3 backlog

**Blocking the product, in rough priority:**

1. **Footage selection + music bed** (`03 §6`, coupled by §12.13). Unblocks G1b and real jump cuts.
2. **Remotion Lambda** (ADR-7) and its **licensing decision** (ADR-5, deferred 27 Aug).
3. **The retention consent flag** (§12.36) — the policy ships uniformly today.
4. **Rotation on the upload path** (§12.40): only ffprobe's raw stream dimensions are pre-rotation,
   so the first upload path populating from them records every portrait phone video as landscape.
5. **`plan-build`'s hardcoded `112.3` tempo fallback** (§12.33) — the *reference's* tempo leaking
   into arbitrary tenants' plans whenever a beat grid is missing.

**Quality, ruled but unbuilt:**

6. **G8 must require emphasis to be present**, not merely bound it — a reel that emphasises nothing
   passes today (§12.48).
7. **The emphasis scorer must weigh ASR confidence** — a mis-transcription at 0.571 confidence
   became the one word enlarged and coloured on screen (§12.48).
8. **A ≥95% regression tripwire beside G1a's 85% floor** (§12.47): beat-blind fixed-interval cuts
   scored 87% by coincidence at this tempo, so the floor cannot distinguish deliberate snapping from
   luck.
9. **Trim word ends against an RMS floor** (§12.40) — faster-whisper runs word ends into silence,
   making those spans uncuttable and leaving captions on screen after speech stops.
10. **The undo race in `content-gate.ts`** (§12.33) — counts plans before taking its row lock.
11. **`render_attempts` garbage collection** (§12.38), and **`motion_templates`' deprecated
    behavioural columns** (§12.32).

**Known and accepted:**

- Caption placement no longer differentiates templates now that all three use the bars; only
  typography, grade and cut rhythm do.
- The Lighthouse band for the web app sits at 84 against an 85 target, dominated by an unsplit
  bundle (M1 carry-over).
