# Changelog

Notable changes to MCOS. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning will follow [SemVer](https://semver.org) from 1.0.0 onward.

## [Unreleased]

### Added
- Milestone 1 vertical slice: meeting creation → Recall bot dispatch → verified
  webhooks → artifact pipeline into Cloudflare R2 → LLM extraction → human
  review gate → append-only versioned Living Positioning Brief.
- Three-screen workspace UI: Meetings, Review Queue, Brief.
- 62 tests, including a full webhook-replay pipeline suite against a real Postgres.
- Open-source project scaffolding: Apache-2.0, CI, CodeQL, Dependabot, templates.

### Notes
- Extraction runs on OpenAI Structured Outputs (`gpt-5.6-terra` by default). The
  original specification fixed Anthropic; the swap was an explicit decision, not
  drift. See `IMPLEMENTATION.md` § 0.
- Recall.ai and Cloudflare R2 have **not** yet been exercised against live
  credentials. OpenAI extraction has.
