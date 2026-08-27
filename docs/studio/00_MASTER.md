# PerfStaq Content Studio — Master Build Plan

> **Entry point.** Place this whole folder at repo root as `docs/studio/`. Run the Orchestrator prompt (§5) in Claude Code from the repo root. The orchestrator reads every doc referenced here, spawns worker agents in git worktrees, and loops until the Definition of Done (§6) is met.

## 1. Mission

Ship a Content Studio that renders reels at **₹5,000-professional-editor quality** from the client's own footage, driven by the approved Living Positioning Brief that M1 already produces.

Two capabilities:
- **A. Template render** — user uploads footage + picks a template → broadcast-quality reel out.
- **B. Style transfer** — user uploads a *reference reel* → system extracts its edit fingerprint → re-renders the user's footage in that style.

Non-negotiable quality bar, derived from real measurement of the reference (see `01_REFERENCE_ANALYSIS.md`): **cuts land on musical beats (median ≤150ms error), captions are word-level and spring-animated, every shot has continuous micro-motion, one word per phrase gets emphasis treatment.** A render that fails these is rejected by the Reviewer agent.

## 2. Document map — read these in order

| Doc | Contents | Primary consumer |
|---|---|---|
| `01_REFERENCE_ANALYSIS.md` | Frame-by-frame teardown of the reference reel with measured numbers (cut rhythm, beat-lock, caption layers, motion) | All agents — this is the spec of "good" |
| `02_MOTION_SYSTEM.md` | The motion design system: spring physics constants, caption engine, emphasis detection, micro-motion, transitions, grade | Agent M (motion), Agent T (templates) |
| `03_RENDER_PIPELINE.md` | Remotion + Lambda architecture, job flow, WhisperX/librosa analysis stage, R2, BullMQ | Agent P (pipeline) |
| `04_STYLE_TRANSFER.md` | EditFingerprint extraction and mapping onto templates | Agent F (fingerprint) |
| `05_BRIEF_INTEGRATION.md` | ContentBrief object; how the approved Brief drives script, hook, emphasis, template choice; review gate reuse | Agent B (brief→studio) |
| `06_AGENTS_AND_MODELS.md` | Agent roster, model routing (Opus 5 / Opus 4 / Sonnet / Haiku), fallback ladder, worktree rules, loop protocol | Orchestrator |
| `07_QUALITY_GATES.md` | Automated + human quality checks every render must pass; the reject loop | Reviewer agent, CI |

## 3. What already exists (do not rebuild)

- **M1 ring, shipped and tested:** meeting → extraction → human review gate → versioned Living Positioning Brief. Stack: TypeScript/Node, Postgres+Prisma, BullMQ+Redis, Cloudflare R2, Anthropic API, React, AWS.
- **PerfStack pipeline (prior work):** Remotion, WhisperX, FFmpeg. **Port it, don't rewrite it.** Agent P's first task is to inventory what's reusable.
- **Review gate UI:** the approve/edit/reject queue. Content briefs reuse this exact surface — no new approval UI.

## 4. Invariants (violating any = PR rejected)

1. **Gate-only writes.** ContentBriefs and fingerprint-derived claims enter through the existing human review gate. Nothing auto-writes to memory.
2. **Generation reads approved memory only.** No raw transcripts, no open internet, no unapproved claims.
3. **Citation or refusal.** Every generated brief carries `claim_ids[] + framework_id + expected_metric`, or refuses with "not in memory."
4. **No synthetic media.** Real footage, real recorded voice. No AI avatars, no generated faces, no cloned voices. (Standing architectural constraint.)
5. **Reference audio is never reused.** Style transfer copies rhythm, never the track. Licensed music only.
6. **Every render is reproducible** from `{ContentBrief, template_id, footage_ref, seed}`.
7. Additive migrations only. Model IDs in env vars, never hardcoded.

## 5. Orchestrator prompt (paste into Claude Code at repo root)

```
Read docs/studio/00_MASTER.md and every doc it references, plus CLAUDE.md. Then:

1. Inventory the existing PerfStack repo/pipeline. Report what is reusable
   (Remotion compositions, WhisperX wiring, FFmpeg utils) before any agent writes code.
2. Create branch studio-main from main. Create worktrees per 06_AGENTS_AND_MODELS.md §3.
3. Spawn agents per 06_AGENTS_AND_MODELS.md §2, giving each ONLY its own spec docs
   plus 01_REFERENCE_ANALYSIS.md and CLAUDE.md.
4. LOOP PROTOCOL: after each agent PR, the Reviewer agent runs 07_QUALITY_GATES.md
   against a real render. If any gate fails, dispatch a fix task back to the owning
   agent with the specific failing metric. Repeat until all gates pass. Do not
   advance to the next phase with a failing gate.
5. After every merge into studio-main, run the full suite in the main worktree.
   Red suite halts downstream agents.
6. When §6 Definition of Done is met, open PR studio-main → main with the
   before/after render comparison attached.

Build order: P (pipeline) → M (motion) → T (templates) → B (brief integration)
→ F (fingerprint/style transfer). M and T may overlap; F starts only after T merges.
```

## 6. Definition of Done

- [ ] A ContentBrief generated from a real approved Brief version renders to MP4 end-to-end.
- [ ] Rendered output passes every gate in `07_QUALITY_GATES.md` — including **beat-lock: ≥85% of cuts within 150ms of a detected beat** (reference achieves 86%).
- [ ] Style transfer: upload the reference reel + new footage → output visibly matches its rhythm and caption cadence.
- [ ] Three templates shipped, each rendering correctly at 1080×1920 / 30fps.
- [ ] Side-by-side comparison recorded: our render vs the reference.
- [ ] Zero regressions in the M1 ring test suite.

## 7. Out of scope

AI avatars/voice clones (invariant 4) · auto-publishing to platforms · competitor teardown ingestion (separate milestone) · multi-language captions · the Strategy screen.
