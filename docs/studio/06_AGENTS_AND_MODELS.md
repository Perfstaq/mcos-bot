# 06 — Agents, Models & The Loop

## 1. Model routing

**Principle:** Opus does architecture, review, and anything where a wrong decision cascades. Cheaper models execute precise specs. The specs in this folder are deliberately detailed so workers don't need the top model.

| Role | Model | Why |
|---|---|---|
| **Orchestrator** | **Opus 5** | Coordinates worktrees, dependency order, the fix loop. Mistakes cascade everywhere. |
| **Architect** (one-shot, before any code) | **Opus 5** | Reviews the existing PerfStack inventory, finalizes schema + module boundaries, writes ADRs. |
| **Reviewer / QC** | **Opus 5**; never below **Opus 4** | Judges renders against 07_QUALITY_GATES + the anti-amateur checklist. This is the taste gate — cheaping out here means shipping amateur output. |
| **Agent M — motion system** | **Opus 4** | Spring physics, emphasis scoring, beat-snap algorithm. Judgment-heavy; spec is precise. |
| **Agent F — fingerprint/style transfer** | **Opus 4** | CV/audio analysis with fuzzy mapping decisions. |
| **Agent P — render pipeline** | **Sonnet** | Well-specified plumbing: BullMQ, R2, Lambda, ffprobe. Escalate to Opus 4 if Lambda config fights back. |
| **Agent T — templates** | **Sonnet** | Remotion compositions built on M's primitives. Escalate to Opus 4 for the first template only (it sets the pattern). |
| **Agent B — brief integration** | **Sonnet** | API + tool schema + reuse of existing gate UI. |
| **Agent D — docs/fixtures/tests** | **Haiku** | Fixtures, test scaffolds, doc updates. |

**Fallback ladder:** Opus 5 → Opus 4 → Sonnet → Haiku. Never skip a rung.
1. Announce every downshift in the PR body: "built partially on {model} due to limits."
2. Downshift only at a commit boundary. Never mid-file.
3. **Reviewer never drops below Opus 4.** If unavailable, PRs queue unreviewed. A Sonnet-reviewed render is an unreviewed render.
4. If Opus 5 is exhausted and the Architect task isn't done, **pause** — do not let Sonnet set architecture.
5. Batch Opus work (architecture decisions, QC review sessions) into planned windows; run Sonnet/Haiku work during cooldowns.

**Runtime models (the product, not the build):** all IDs in env vars, never hardcoded.
```
CONTENT_BRIEF_MODEL=claude-opus-4-8      # generation quality ceiling, low volume
CONTENT_BRIEF_FALLBACK=claude-sonnet-4-6
VISION_CLASSIFY_MODEL=claude-sonnet-4-6  # fingerprint style classification, higher volume
CAPTION_UTIL_MODEL=claude-haiku-4-5-20251001
```
Tag every generated ContentBrief with `generated_by_model`. Never mix models within one brief.

## 2. Agent roster & dependencies

```
Architect (Opus 5, one-shot)
   ↓
Agent P (pipeline) ──┬──> Agent M (motion) ──> Agent T (templates) ──> Agent F (style transfer)
                     └──> Agent B (brief integration)   [parallel with M/T]
Agent D (fixtures/tests)  [parallel throughout]
Reviewer  [gates every PR]
```

## 3. Worktrees

```bash
git worktree add ../st-p -b feat/studio-pipeline  studio-main
git worktree add ../st-m -b feat/studio-motion    studio-main
git worktree add ../st-t -b feat/studio-templates studio-main
git worktree add ../st-b -b feat/studio-brief     studio-main
git worktree add ../st-f -b feat/studio-style     studio-main
git worktree add ../st-d -b feat/studio-fixtures  studio-main
```
One worktree per agent so parallel agents never share a working directory. All PRs target `studio-main`; one final PR `studio-main → main`.

## 4. THE LOOP — context engineering protocol

This is the part that makes it finish instead of drifting.

```
for each agent task:
  1. PLAN MODE FIRST. Agent restates its spec in its own words, lists files it
     will touch, files it will NOT touch, and the tests it will write.
     If the plan conflicts with an invariant in 00_MASTER §4 → STOP and report.
  2. Write the failing test from the acceptance criteria. Then implement to green.
  3. RENDER A REAL VIDEO. Every agent that touches motion, templates, or pipeline
     must produce an actual MP4 before opening a PR. No PR without output.
  4. Reviewer runs 07_QUALITY_GATES against that MP4 plus the anti-amateur checklist.
  5. If any gate fails → the Reviewer returns the SPECIFIC failing metric
     (e.g. "beat_lock_ratio 0.61, target 0.85") and the agent iterates.
     Loop 2-5 until green. Do NOT advance phases with a failing gate.
  6. On merge: orchestrator re-runs the full suite in the main worktree.
     Red suite halts all downstream agents.
```

**Context discipline for each agent:** an agent receives `00_MASTER.md` + `01_REFERENCE_ANALYSIS.md` + `CLAUDE.md` + only its own spec doc. Not the whole folder. This keeps context tight and prevents cross-contamination of concerns.

**When an agent is stuck (3 failed iterations on the same gate):** escalate one model rung, and if still stuck, halt and surface to the human with the failing metric and what was tried. Never let an agent grind indefinitely.

## 5. PR requirements
Scope · schema changes · **the rendered MP4 attached** · QC report with every gate's measured value · invariant checklist ticked · out-of-scope notes under "Later". No agent merges its own PR.
