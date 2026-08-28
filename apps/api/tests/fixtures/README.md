# Recall webhook replay fixtures

Payload shapes recorded from Recall.ai's documented schemas (Aug 2026):

- Bot status change events — https://docs.recall.ai/docs/bot-status-change-events
- Recording / media artifact events — https://docs.recall.ai/docs/recording-webhooks
- Transcript download JSON — https://docs.recall.ai/docs/download-schemas

Every event shares one envelope:

```
{ event, data: { data: { code, sub_code, updated_at },
                 bot?: {id}, recording?: {id}, transcript?: {id} } }
```

Ids are stable placeholders. The pipeline test rewrites `data.bot.id` to the
bot id of the meeting under test, then signs each payload with a test secret
using the same HMAC the production verifier uses — so the fixtures exercise
signature verification for real rather than bypassing it.

`bot.recording_permission_allowed` and `bot.recording_permission_denied` cover
the permission-gated recording start some meeting platforms require — both are
handled in `domain/webhook.ts` (the former maps to `bot_joined`, the latter is
a failure event) but had no fixture until the milestone-1 fixtures audit added
them here, in the same envelope shape as every other bot event.
