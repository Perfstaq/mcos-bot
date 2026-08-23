## What this changes

<!-- One paragraph. If you need the word "also", this is probably two PRs. -->

## Why

<!-- The problem, not the diff. -->

## How it was verified

<!-- Commands run and what they actually printed. "Tests pass" is a claim;
     the output is evidence. Say explicitly if something is unverified. -->

```
```

## Architectural invariants

Confirm each, or explain why the change is correct anyway:

- [ ] The review gate remains the **only** write path into `brief_versions` / `brief_claims`
- [ ] Claims still require an evidence source **and** at least one resolvable transcript segment
- [ ] Append-only tables are still append-only (`review_decisions`, `state_transitions`, `brief_*`, `webhook_events`)
- [ ] Webhook signatures are verified before any other work, in every environment
- [ ] No query reaches around the tenancy extension in `apps/api/src/db.ts`
- [ ] No polling of the Recall API was introduced

## Checklist

- [ ] `npm run typecheck`, `npm test` and `npm run build` all pass locally
- [ ] Tests cover the new behaviour, including the failure path
- [ ] Docs updated (`README.md` / `IMPLEMENTATION.md`) if behaviour or setup changed
- [ ] `.env.example` updated if configuration changed
- [ ] No credentials, tokens or customer data in the diff
