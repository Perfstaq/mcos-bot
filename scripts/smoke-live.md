# Live smoke test

A manual, step-by-step run of the whole ring against a **real** Google Meet
call — real Recall.ai bot, real webhook deliveries, real transcript, real
OpenAI extraction. Nothing here is mocked. This is the one test in the repo
that a green CI run cannot stand in for: `e2e/tests/ring.spec.ts` proves the
review gate and the brief with a deterministic mock in place of the model
call (see its header comment); this proves Recall and OpenAI actually work
together, end to end, against your own credentials and region.

Run this before a demo, after rotating `RECALLAI_API_KEY` or
`RECALL_WEBHOOK_SECRET`, or any time you touch webhook verification, the
Recall client, or extraction and want more than the test suite's word for it.

Budget 15–20 minutes, most of it waiting on a real transcription job.

---

## 0. Before you start

- `.env` filled in for real: `RECALLAI_API_KEY`, `RECALL_WEBHOOK_SECRET`,
  `OPENAI_API_KEY`, R2 credentials, and `APP_BASE_URL` set to a **static**
  ngrok URL (`ngrok http 8787 --domain=<your-static-subdomain>.ngrok-free.app`
  or equivalent). Recall 403s any webhook target containing `localhost` or a
  bare IP, so this is not optional and it cannot be skipped by testing
  against a Recall dashboard sandbox instead.
- `npm run db:up && npm run db:migrate && npm run db:seed:demo` has been run
  at least once. This smoke test does not depend on the demo seed's data,
  only on the demo tenant/reviewer identity existing to sign in as.
- `npm run dev:api` and `npm run dev:worker` both running in separate
  terminals, and ngrok pointed at the API port (8787).
- A real, joinable Google Meet link you control, ideally one you can start
  ahead of time and leave running (a solo meeting with yourself is enough —
  the bot only needs something to transcribe).
- `jq` for reading the curl responses below. Swap in `python3 -m json.tool`
  or your browser's network tab if you do not have it.

Set once, reused throughout:

```bash
API=https://<your-static-subdomain>.ngrok-free.app/api/v1
AUTH="-H 'x-tenant-slug: freshworks-demo' -H 'x-reviewer-email: demo@freshworks.example'"
# AUTH_DEV_HEADERS must be true in .env for the header pair above to work.
# Sign in through the web UI instead if you have turned it off.
```

---

## 1. Dispatch the bot

```bash
curl -s -X POST "$API/meetings" \
  -H 'content-type: application/json' \
  -H 'x-tenant-slug: freshworks-demo' -H 'x-reviewer-email: demo@freshworks.example' \
  -d '{"meeting_url": "https://meet.google.com/xxx-yyyy-zzz", "title": "Live smoke test"}' \
  | jq
```

**Expect:** `201`, `meeting.status: "bot_scheduled"`, `meeting.recall_bot_id`
set. Save the id:

```bash
MEETING_ID=<id from the response>
```

| If instead | Cause | Fix |
|---|---|---|
| `502 recall_dispatch_failed` | Bad `RECALLAI_API_KEY`, or `meeting_url` isn't a URL Recall recognises | Check the key is for the *region* in `RECALL_REGION`; a key from the wrong region 401s | 
| Meeting created but stuck in `draft` | The bot dispatch call itself hung or the process crashed mid-request | Check `dev:api` logs; retry is not needed, just re-`POST /meetings` |

## 2. The bot joins

Watch `apps/api` and `apps/worker` logs, or poll:

```bash
watch -n 3 "curl -s $API/meetings/$MEETING_ID -H 'x-tenant-slug: freshworks-demo' -H 'x-reviewer-email: demo@freshworks.example' | jq '.meeting.status, .meeting.failure_reason'"
```

**Expect the sequence**, each a real webhook delivery:

```
bot_scheduled → bot_joined → recording → call_ended → media_processing → transcript_ready
```

Admit the bot into the call if your Meet lobby requires host approval — it
will not progress past `bot_scheduled` until it is actually in the call.

| Stuck at | Webhook that should have arrived | Likely cause |
|---|---|---|
| `bot_scheduled` | `bot.in_call_not_recording` / `bot.recording_permission_allowed` | Bot is in the waiting room and nobody admitted it, or the meeting link expired |
| `bot_joined` | `bot.in_call_recording` | Recording permission denied in-meeting — check for a `failed` transition with `failed_stage: "bot.recording_permission_denied"` |
| `recording` | `bot.call_ended` / `bot.done` | The call is still going. This state only advances when the call actually ends |
| `call_ended` | `recording.done` | Recall is still rendering the mixed recording — can take a minute or two on a longer call |
| `media_processing` | `transcript.done` | The async transcript job is still running, or `ingest-recording` failed downloading the audio — see §4 |

**No webhooks arriving at all, at any stage?** This is almost always ngrok or
the webhook secret, not Recall:

```bash
curl -s https://<your-ngrok-domain>/healthz   # must be reachable from the public internet
```

Check the Recall dashboard's webhook delivery log for the workspace — a
403/401 there means `RECALL_WEBHOOK_SECRET` does not match what you set as
the workspace secret. See `docs/RUNBOOK.md`'s "The Recall webhook secret
rotated" section for the overlap-window procedure if you need to rotate it
without dropping events.

## 3. Transcript lands, extraction runs — for real

Once `transcript_ready`, the extraction job picks it up automatically
(`extracting` → `in_review`), calling **the real OpenAI API** with
`OPENAI_MODEL` from your `.env`. This is the one step that costs real money
and takes real (if short) latency — expect single-digit seconds per chunk.

```bash
curl -s "$API/meetings/$MEETING_ID" -H 'x-tenant-slug: freshworks-demo' -H 'x-reviewer-email: demo@freshworks.example' | jq '.meeting.extraction'
```

**Expect** `status: "succeeded"`, `chunks > 0`, `persisted > 0`. `dropped` is
not itself a problem — it is the evidence gate refusing claims whose quote
does not resolve to a real transcript segment. A high drop rate on a short,
casual transcript ("live smoke test, just talking to myself") is completely
normal; do not read this test's own transcript quality as a proxy for the
extractor's quality against a real meeting.

| Extraction status | Meaning |
|---|---|
| `succeeded`, `persisted: 0` | Nothing in this transcript reached the confidence/evidence bar — try a call with actual positioning content in it |
| `failed`, `error` mentions 401 | `OPENAI_API_KEY` is wrong or revoked |
| `failed`, `error` mentions the model name | `OPENAI_MODEL` in `.env` names a model your key cannot reach |
| stuck at `extracting` | Worker crashed mid-run, or a rate limit is being retried (3 attempts, 15s backoff) — check `dev:worker` logs |

## 4. Review it, for real, in the browser

Open `http://localhost:5173/review` (or wherever `npm run dev:web` is
serving) and sign in as `demo@freshworks.example` (password: whatever
`npm run db:seed:demo` printed, or `SEED_PASSWORD` if you set one).

- Confirm the claims on screen quote **your own words** back at you, with
  the right speaker and timestamp — this is the one thing a mocked test can
  never verify, because the mock's evidence is synthetic.
- Exercise the keyboard: `a` to keep, `e` then type then `⌘⏎`/`⌃⏎` to
  rewrite-and-keep, `r` to toss, `⇧A` to bulk-keep the high-confidence ones.
- Click **Merge approved → brief**.

**Expect:** redirect to `/brief?v=<n>&diff=1`, the diff banner naming what
just changed, and your kept claims present in the document with working
"show evidence" quotes.

## 5. Clean-up

```bash
curl -s -X DELETE "$API/meetings/$MEETING_ID" -H 'x-tenant-slug: freshworks-demo' -H 'x-reviewer-email: demo@freshworks.example'
```

This purges the recording/transcript and any claims that never reached the
brief; anything you merged survives with its evidence redacted (see
`routes/meetings.ts`'s delete handler) — that is the intended behaviour, not
a bug in the cleanup.

---

## Retrying a failed stage

`POST /meetings/:id/retry` (also a button in the Meetings screen) resumes
from where the meeting actually died, using `meeting.failed_stage`:

| `failed_stage` | What retry does |
|---|---|
| `dispatch` (or any `bot.*` failure event) | Dispatches a brand-new Recall bot at the same URL |
| `ingest-recording` | Re-enqueues the recording download, using the recording id already on file |
| `extract` | Re-runs extraction against the transcript already ingested — no new Recall call |
| anything else (e.g. an `ingest-transcript` failure) | Falls through to a fresh bot dispatch, same as `dispatch` — there is currently no narrower retry for a failed transcript *ingest* specifically, only for a failed transcript *request* |

A meeting only reaches `failed` from one of: bot dispatch throwing, one of
the four Recall failure events (`bot.fatal`,
`bot.recording_permission_denied`, `recording.failed`, `transcript.failed`),
or a job in the worker exhausting its retries. Check `meeting.failure_reason`
alongside `failed_stage` — it carries the underlying error message or the
Recall `sub_code`.
