# 05 — Brief → Studio Integration

Agent B owns this. This is the connective tissue between the shipped M1 ring and the Studio.

## 1. The handoff object

Strategy emits it, Studio consumes it. Neither side knows the other's internals.

```ts
ContentBrief {
  id, tenant_id, brief_version_id      // which memory version produced this
  claim_ids: string[]                   // MANDATORY — provenance
  framework_id: string                  // MANDATORY — why this angle
  framework_evidence_tier: 'A'|'B'|'C'  // how validated the framework is
  archetype: 'objection_killer'|'contrarian'|'pain_ladder'|'transformation'
           |'myth_bust'|'bts'|'listicle'|'client_story'|'category_ed'|'founder_pov'
  hook_text: string                     // becomes the banner
  emphasis_word: string                 // the ONE colored word
  beats: [{ role:'hook'|'agitate'|'resolve'|'proof'|'cta',
            script: string, target_ms: number, fills_from: claim_type[] }]
  template_id: string
  channel: 'reels'|'shorts'|'tiktok'|'linkedin'
  content_mix_slot: 'brand'|'activation'   // 95/5 + 60/40 routing
  expected_metric: 'sends_per_reach'|'saves'|'watch_time'|'profile_visits'
  status: 'proposed'|'approved'|'rejected'|'edited'
}
```

## 2. Generation rules

- Reads **approved claims only** from the current brief version. No raw transcripts, no internet.
- Anthropic **tool-calling schema** produces the object — never parsed free text.
- **Citation or refusal:** a ContentBrief with an empty `claim_ids` is invalid and dropped. If memory can't support the archetype (e.g. no `proof_point` for a `client_story`), the engine refuses that archetype and says so, rather than inventing.
- Framework selection is the engine's job, not the user's: score frameworks against claim signals, recommend one, surface 2 alternatives with rationale. Evidence tier A frameworks (double jeopardy, ESOV, 60/40) outrank tier C (StoryBrand, hook taxonomies) when signals conflict.

## 3. Reuse the review gate — build no new approval UI

ContentBriefs land in the **existing** review queue as a new card type. Same keyboard (A/E/R), same audit log, same `review_decisions` table. The card shows: hook, archetype, beats, and the WHY line (`claim_ids + framework + expected_metric`) with source chips exactly like claim cards.

Only `status='approved'` briefs can enter `plan.build`. Enforce at the service layer.

## 4. API

```
POST /api/v1/content/briefs        { brief_version_id, channel, count }  → ContentBrief[] (proposed)
POST /api/v1/content/briefs/:id/approve | /reject | PATCH (edit-then-approve)
POST /api/v1/content/plans         { content_brief_id, template_id, footage_asset_id } → RenderPlan
POST /api/v1/content/renders       { plan_id } → Render (queued)
GET  /api/v1/content/renders/:id   → status, r2 url, qc report
```

## 5. Feedback slot (Phase 2, design now)

Each `Render` stores its originating `claim_ids + framework_id + expected_metric`. When performance data arrives, it re-enters as evidence through the same gate and updates framework scores per tenant. **This is the loop that makes the product compound** — leave the columns in place now even though the loop ships later.
