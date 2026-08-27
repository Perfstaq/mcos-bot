# 90-second demo

The pitch in one sentence: **a model proposes, a human decides, and nothing
skips that gate.** This script proves it in three moves — review a call by
keyboard, watch the edit survive next to the original, merge, and see exactly
what changed.

Uses the built-in demo seed (`npm run db:seed:demo`), not the golden e2e
fixtures — one short, plausible call ("Mid-market positioning review", 11
proposed claims) that a person can read and judge in the time it takes to
say the words below out loud. Screen recording is a manual step: hit record
before §1, stop after §5. Nothing in this repo can do that for you.

---

## Before the room fills up

```bash
npm run demo:reset   # see "Resetting between runs" below — do this every time
npm run dev           # api + worker + web, one command
```

Sign in at `http://localhost:5173/signin` as `demo@freshworks.example` (the
password `npm run db:seed:demo` printed, or `SEED_PASSWORD` if you set one)
**before** you start recording — the sign-in screen is not part of the story.

Land on **Meetings** with the demo call selected. Confirm its status reads
`in_review` and the claim count says 11 — if it does not, `npm run
demo:reset` did not finish; re-run it and check the terminal output.

---

## §1 — Meetings (10s)

**Click:** the "Mid-market positioning review" row.

**Say:** "This call already ran the pipeline — bot joined, transcript came
back, the model proposed eleven claims. Nothing from this list is in our
positioning brief yet. Nothing gets in without a human saying so."

Point at the stat row: *Proposed 11 · Approved 0 · Rejected 0*. That's the
whole point on one line.

## §2 — The gate, by keyboard (35s)

**Click:** "Review 11 proposals."

**Say, while doing it, not before:**

- Land on the first card. "Every claim carries its evidence — the exact
  quote, who said it, when." Point at the quote block.
- Press **`a`**. "Keep. One key."
- Press **`e`**, type a tightened version of the claim on screen, press
  **`⌘⏎`** (or **`⌃⏎`**). "Edit-then-keep is one action — the model's
  version stays on the audit trail next to mine, not overwritten."
- Press **`r`** on the next one. "Toss. Doesn't reach the brief, and it's
  still logged on the right — nothing here disappears silently."
- Press **`⇧A`**. "Keep every high-confidence claim left, in one shot — this
  is the move for a reviewer clearing a call fast." Watch the queue clear
  (or clear the last one or two by hand if anything was flagged for a read).

**Say, queue empty:** "That's the whole call decided. Nothing has touched
the brief yet — watch."

## §3 — Merge (10s)

**Click:** "Merge approved → brief."

**Say:** "That one click just wrote an immutable version of the brief. Not
edited an old one — a new one, sitting next to every version before it."

You land on `/brief?v=1&diff=1` automatically — no extra navigation needed.

## §4 — The diff (15s)

**Say, pointing at the banner at the top of the document:** "This is what
that merge changed — ten added, right where the count came from." Scroll to
the claim you rewrote in §2. "There it is, live in the document, marked the
same as every other claim this merge added."

Do not claim the banner reads "added, edited, removed" as if all three were
nonzero — on a first merge they cannot be. **Edited** and **removed** are
always 0 here: there is no earlier version to diff against, so nothing yet
counts as changed or gone, only new. And the count is **ten**, not eleven —
not because anything was "removed" (a claim rejected in §2 before it was
ever added does not show up as removed; it just was never added), but
because the queue held eleven and you kept ten.

This is also not the edited claim from §2. The struck-through "model said /
I said" comparison lives only in the review queue while you are deciding,
and afterward in that claim's review decision — the document itself always
shows a claim's current, approved text, marked **+ NEW** like everything
else this merge added, not a diff against its own pre-edit self. The real
**~ EDITED** marker, with the original struck through, appears only when an
*already-merged* claim is re-decided in a *later* version — a second
review, not this one (see the "v3" step in `e2e/tests/ring.spec.ts` for
exactly that case). Do not go looking for it here.

## §5 — The version rail (10s)

**Click:** a different version in the right-hand rail (there is only v1 on a
fresh reset — if you have run the ring more than once without resetting,
click v1 explicitly here to make the point).

**Say:** "Every version is exactly what it was the moment it was merged.
Nothing here gets rewritten by a later edit — that's what makes this an
audit trail instead of a wiki page."

**Close on:** "Meetings, gate, brief. The model never gets a fourth screen."

---

## Resetting between runs

```bash
npm run demo:reset
```

**What it actually does:** deletes the `freshworks-demo` workspace outright
— organization, tenant, meetings, claims, decisions, brief versions, all of
it, via cascade — and reseeds it fresh with `npm run db:seed:demo --demo`'s
same 11-claim call. It does **not** un-decide claims or delete individual
`brief_versions` rows to "rewind" the tenant in place: those tables are
append-only by design (see `CLAUDE.md`'s invariant 3), and a reset script
that quietly violated that for its own convenience would be a worse demo
than a slow one. The honest reset is that the demo tenant does not survive
between demos.

**This is dev-only and destructive.** It refuses to run when `NODE_ENV=
production` (same guard as `apps/api/src/seed-golden.ts`), but that is a
backstop, not a reason to point it at anything you would mind losing. Never
run it against a real tenant's data, and never against the shared database
your team develops against if `freshworks-demo` has come to mean something
real there — this reset assumes the workspace exists purely to be thrown
away before the next demo.

**Full reset-and-run budget:** under 5 minutes, most of it `npm run dev`
warming up. `npm run demo:reset` itself finishes in a few seconds — it is
one cascading delete and one seed script, not a rebuild.

---

## If something goes sideways mid-demo

- **A claim you didn't expect is in the queue.** You forgot to reset, or
  someone reviewed this tenant since. Do not try to fix it live — say "let's
  come back to this one" (skip with `j`), keep moving, reset properly
  afterwards.
- **The merge button 409s ("nothing changed" or "someone was deciding
  claims").** Press it again — see `routes/brief.ts`; a concurrent decision
  lost the race, and merging again is the correct response, not a bug to
  explain.
- **Sign-in fails.** You are not on the reset tenant's password — check
  which `SEED_PASSWORD` (if any) was set when you last ran
  `db:seed:demo`/`demo:reset`; both print the answer to the terminal.
- **Nothing here recovers a botched recording.** Reset, re-run from §1. The
  whole script is under 90 seconds precisely so this costs you two minutes,
  not ten.
