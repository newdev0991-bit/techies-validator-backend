# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js Express backend that validates UK B2B business leads with OpenAI, deciding whether a lead
is a good prospect from timing, business type, location and contact evidence. It is one half of a
versioned integration: the API in this repo, and the Apify Actor under [actor/](actor/) that
gathers the Facebook evidence the API reasons over.

## Commands

### Development
```bash
npm install         # Install API dependencies
npm start           # Start the server (production and dev)
npm run dev         # Same as npm start (no hot-reload)
npm test            # API suite (node --test test/*.test.js)

cd actor && npm install && npm test   # Actor suite, separate package
```

The server runs on port 4000 by default (or `PORT`).

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Liveness plus the active batch contract and batch size |
| GET | `/pipeline-capabilities` | Contract and cap discovery; `pipelineAccess`-guarded |
| POST | `/analyze`, `/validate` | Single-lead analysis; the same handler serves both |
| POST | `/validate-batch` | Batched Actor + analysis run |
| POST | `/pipeline/validate-batch` | Same handler, `pipelineAccess`-guarded |
| POST | `/validate-business` | Business-identity check |
| POST | `/fetch-results` | Facebook post date for a single `Lead Proof URL` |

`pipelineAccess` ([src/pipeline-capabilities.js](src/pipeline-capabilities.js)) requires a
`Bearer $COT_PIPELINE_API_KEY` header compared in constant time, and returns 503
`PIPELINE_NOT_CONFIGURED` unless `COT_ACTOR_MAX_CHARGE_USD` is set and
`COT_CONTACT_ACTOR_READY=true`. Never add a paid Actor route without that guard.

```bash
curl http://localhost:4000/health

curl -X POST http://localhost:4000/analyze \
  -H "Content-Type: application/json" \
  -d '{"lead": {"Company Name": "Test Ltd", "Industry Type": "Restaurant"}}'

curl -X POST http://localhost:4000/fetch-results \
  -H "Content-Type: application/json" \
  -d '{"lead": {"Company Name": "Cub Cafe Wigan", "Lead Proof URL": "https://www.facebook.com/permalink.php?story_fbid=..."}}'
```

## Architecture

[server.js](server.js) holds the Express app, the prompt and the request handlers; the reusable
logic lives in [src/](src/) and the scraper in [actor/](actor/). `server.js` also exports `app`
and several pure functions (`buildPrompt`, `constrainAnalysisToEvidence`, `finalizeCotAnalysis`,
`createCotBatchHandler`) so the tests can drive them without a listening socket.

### server.js

- **Middleware** — CORS from an allowlist (`ALLOWED_ORIGINS`/`FRONTEND_ORIGIN`, plus project
  Vercel origin patterns; a missing Origin is allowed for curl/Postman), a 1 MB JSON body limit,
  and `express-rate-limit` at `RATE_LIMIT_MAX` requests per minute returning `RATE_LIMITED`.
- **`buildPrompt`** — builds the OpenAI prompt from the CSV-style lead fields below and encodes
  the UK B2B rules: GOOD for new businesses, relocations, expansions and ownership changes; BAD
  for the education sector, established businesses, and non-UK locations (Ireland, Northern
  Ireland, Isle of Man). Returns structured JSON — verdict, reasoning, confidence, recommendation.
  The static spec is ~4KB and still sits in the per-lead user message, so OpenAI prompt caching
  does not apply; moving it needs a prompt restructure plus a replay eval.
- **`analyzeLead`** — one OpenAI call in JSON mode (`response_format: { type: 'json_object' }`;
  the system message must contain lowercase "json" to satisfy that mode). Wrapped in an abort
  timeout plus a hard deadline race, because aborting a fetch does not always unblock a body read
  on a half-open socket. Retries 429 and 5xx with capped backoff honouring `Retry-After`; a 429
  carrying `insufficient_quota` is **not** retried and fails fast as `OPENAI_QUOTA_EXHAUSTED`.
- **`analyzeHandler`** — serves `/analyze` and `/validate`, returning
  `{ content: [{ text: "<json_string>" }] }` for frontend compatibility.
- **`mapWithConcurrency`** — order-preserving bounded parallel map at `ANALYZE_CONCURRENCY`.
  The batch fan-out was once an unbounded `Promise.all`, which turned a single rate-limit into a
  burst of simultaneous 429s. Do not reintroduce an unbounded fan-out over paid calls.
- **Apify integration** — `runFacebookActor` (single lead) and `runFacebookActorBatch` (batch)
  call the Actor and wait for completion, under a batch deadline and a per-request timeout, with
  a fingerprinted result cache. The Actor uses logged-out HTTP: no Facebook account cookies are
  read or forwarded. Errors log under a `[fetch-results]` prefix.

### src/

`card-data.js` (lead normalisation) and `freshness.js` (activity/recency scoring) carry most of
the domain logic. Around them: `validation.js`, `cot-identity.js`, `cot-events.js`,
`cot-contacts.js`, `cot-contact-workflow.js`, `cot-batch.js`, `contact-sources.js`,
`search-author-contacts.js`, `apify-errors.js`, `pipeline-capabilities.js`, and the two opt-in
web-search paths `web-verdict.js` and `web-contact-recovery.js` over `openai-web-search.js`.

Several of these files are vendored into the `techies-standalone-leads` repo under `vendor/src/`.
Changing one here means the copy there drifts.

### Cost control

The 2026-09-11 incident drained the OpenAI balance within an hour. Three defaults exist because
of it, and each should be treated as load-bearing rather than tidied away:

- `WEB_VERDICT` and `WEB_CONTACT_RECOVERY` are **OFF** unless set to `on`/`true`/`1`/`yes`. Each
  runs a `web_search` tool call on `gpt-5.6-terra` — many times the cost of a plain completion,
  with no admission gate on the frontend batch path. Set a monthly spend cap before enabling.
- `ANALYZE_CONCURRENCY` bounds the fan-out (default 3, max 10).
- `OPENAI_MAX_RETRIES` bounds retries (default 2); an exhausted balance is never retried.

The web-search model (`WEB_SEARCH_MODEL` for contact recovery, `WEB_VERDICT_MODEL` for the
browsing verdict; both default to `gpt-5.6-terra`) is not a cosmetic choice: gpt-5.5 and gpt-5.4 both cited pages they never opened, so
the provenance check discards their results and the feature yields nothing. Verify a real lookup
still passes provenance before changing it.

## Lead Data Structure

Leads use verbose CSV-style field names from a spreadsheet import system. Keep these exact names
— they match the frontend's data format:

- `"Company Name"`
- `"Industry Type"`
- `"Phone Number"`
- `"Address 1 (Road/Street/Lane/Park/Industrial Estate)"`
- `"Address 2 (Village/Town/City)"`
- `"Post Code (Please Put The Full Postcode, Example: CH41 5LH)"`
- `"County"`
- `"Lead Statement"`
- `"Lead Proof URL"`
- `"Old Address? (For relocation, new branch, and moving premises only with no given address)"`

## Environment

See [.env.example](.env.example) for the full annotated list. The ones worth knowing:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `MODEL` | Analysis model (default `gpt-4o-mini`) |
| `ALLOWED_ORIGINS` / `FRONTEND_ORIGIN` | CORS allowlist |
| `PORT` | Default 4000; Render uses 10000 |
| `RATE_LIMIT_MAX` | Requests per minute (default 60) |
| `ANALYZE_CONCURRENCY` | Parallel `analyzeLead` calls (default 3, max 10) |
| `OPENAI_MAX_RETRIES` | Transient 429/5xx retries (default 2) |
| `OPENAI_TIMEOUT_MS` | Per-call deadline |
| `WEB_VERDICT` / `WEB_CONTACT_RECOVERY` | OFF by default; the main API-cost drivers |
| `WEB_SEARCH_MODEL` / `WEB_VERDICT_MODEL` | Both default `gpt-5.6-terra`; see Cost control |
| `APIFY_API_TOKEN` | Required for Actor runs |
| `APIFY_ACTOR_ID`, `APIFY_ACTOR_CONTRACT` | Actor identity and contract version |
| `COT_BATCH_SIZE` | Rows per Actor batch (1-10, default 3) |
| `COT_ACTOR_MAX_CHARGE_USD` | Required for the guarded pipeline routes |
| `COT_PIPELINE_API_KEY`, `COT_CONTACT_ACTOR_READY` | Pipeline route auth and readiness |
| `LEAD_DATE_ORDER` | `MDY` (Forms/Sheets default) or `DMY` |

## Deployment

Designed for Render:

- Set `PORT=10000`
- Configure all environment variables in the Render dashboard
- No build step — runs directly with `node server.js`
- Frontend typically on Vercel (add its origin to `ALLOWED_ORIGINS`)
