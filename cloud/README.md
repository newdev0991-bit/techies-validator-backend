# Apify COT cloud controller

This is the scheduler controller, distinct from the keyword-search Actor and
the COT evidence Actor in `actor/`. It runs `cloud/main.mjs` using Node 24.
The frontend home page reads its saved results; no CSV input is required.
Manual validation remains available at `/manual` and `/cot`.

## Deployment contract

- Git repository: `newdev0991-bit/techies-validator-backend`, branch
  `codex/apify-cot-cloud-pipeline`, **repository root**, `.actor/actor.json`.
- New private Actor name: `techies-cot-cloud-pipeline`.
- Existing search Actor: `53bGXKeIhVmNMTCi4`; existing COT Actor:
  `J8wBqFJa8GQo9RJ5J`. Do not replace either with the controller image.
- Create a private named key-value store `techies-cot-pipeline-state` and a
  dedicated request queue `techies-cot-pipeline-lock`. Keep both indefinitely.
- Actor environment: `COT_CLOUD_STORE_ID`, `COT_CLOUD_LOCK_QUEUE_ID`,
  `COT_VALIDATOR_BASE_URL=https://techies-validator-backend-i71b.onrender.com`,
  matching secret `COT_PIPELINE_API_KEY`, and `PIPELINE_LIVE_ENABLED=false`.
  Apify supplies the runtime `APIFY_TOKEN`; never copy an account token into Git.
  Keep Limited permissions. The input resource pickers `stateStoreId` and
  `lockQueueId` grant read/write access to those two resources and must match
  the environment IDs. The child search Actor must also use Limited permissions.
- Default run: 512 MB, 900-second timeout, automatic restart disabled.
- Schedule: every minute in UTC, exclusive execution, **disabled** initially.
  Input includes `enabled`, `stateStoreId`, and `lockQueueId`. Setting enabled
  true does not enable processing by itself: named
  storage `CONFIG.enabled` and the Actor environment switch must also be true.

## Preserve the canary before starting

With Node 24, `node cloud/setup.mjs plan` reads the existing
`pipeline/canary-data/pipeline.sqlite` read-only and reports its snapshot hash,
dedup row count and historical spending counters. It makes no cloud calls.

In a secure operator environment, provide `APIFY_API_TOKEN`,
`COT_CLOUD_STORE_ID`, and `COT_CLOUD_LOCK_QUEUE_ID`, then run:

```powershell
node cloud/setup.mjs initialize pipeline/canary-data/pipeline.sqlite
```

This migrates state and publishes the saved frontend results without running
search or validation. It leaves processing disabled and retains the consumed
lifetime limits (one search and one validation). It refuses existing state or
an incomplete initialization marker: reconcile partial writes; never delete
state to restart a migration. The source database and CSV audit stay unchanged.

`COT_CLOUD_ACTOR_ID` plus `node cloud/setup.mjs schedule` can create the disabled
schedule through the official API. It refuses an existing same-name schedule
instead of overwriting it. Neither setup command builds or starts an Actor.
Alternatively configure the same values through Apify Console.

## Frontend connection

The frontend branch `codex/apify-cot-cloud-results` requires server-only values:

- `COT_PIPELINE_STORE_ID`: the named store ID above.
- `COT_PIPELINE_READ_TOKEN`: a token scoped to read this store, where supported.
- `PIPELINE_DASHBOARD_PASSWORD`: dashboard access password.

The browser sends the password only to its own `/api/cot-pipeline` route.
The route reads `RESULTS` with the server credential; it never starts an Actor.
Results are not cached, raw provider responses are withheld, and expired READY
proofs become review-required on every read, including CSV downloads.
Do not use `NEXT_PUBLIC_` for any of these settings. If using a shared password,
put deployment access protection/rate limiting in front of the dashboard.

## Activation checks and costs

Publishing source is not a verified deployment. Before activation, verify the
controller build's cloned branch/commit and perform a disabled-input run. Also
deploy and verify the COT/backend identity/contact fixes that follow the first
canary; the existing readiness flag does not prove those later fixes are live.
Then obtain approval for a bounded canary and recurring limits. Do not reset the
migrated counters to get another run. Adjust lifetime/daily allowances only as
part of the explicitly approved budget.

The prior canary used one search and one validation (0 ready, 2 review, 1 rejected).
Default child-Actor ceilings remain $0.10 search + $0.20 validation, plus OpenAI
and controller/storage charges. A one-minute schedule can create up to 1,440
controller invocations/day even when work is disabled or budgets are exhausted.
Disable the schedule when paused; idle controller runs are not free.
No lead is automatically submitted to techiesdata.org.

## Durability and recovery

A queue lease protects concurrent containers; the schedule is additionally
exclusive. Immutable hash-checked chunks are committed by replacing one STATE
manifest. Paid intent and counters are saved **before** sending a paid request.
A lost response halts for reconciliation instead of silently repeating work.
This is not a guarantee of exactly-once provider billing. The queue is a mutex;
its dummy example.invalid URL is never crawled or marked handled.

State has a 64 MiB cap, individual rows a 4 MiB cap, and the sanitized RESULTS
record an 8 MiB cap. The underlying pipeline stops at 25,000 posts. Old immutable
chunks are retained for audit and can increase storage charges; archive only
after a backed-up, disabled, no-running-controller reconciliation. Missing STATE
always fails closed. Do not enable the old Windows/Linux scheduler against a
separate database at the same time. Local recovery CLI commands do not modify
cloud state: export/reconcile/reimport under the cloud lease deliberately.

## Local verification

`npm run test:cloud` tests remote checkpoints, crashes around paid requests,
overlap/expiry, read-only migration, disabled scheduling and sanitized results.
`npm run test:pipeline`, `npm test`, and `npm test --prefix actor` cover the
existing pipeline and validation rules. Tests use synthetic providers and do
not spend Apify credits. Frontend tests and production build run in its repo.
Local Docker verification requires a running Docker engine.

Official reference: [Apify schedules](https://docs.apify.com/actors/running/schedules).
