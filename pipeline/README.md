# Automatic Techies search, COT validation and contact CSV

## Strict good-lead contact scraping

Validation now has two bounded Actor stages inside one validation batch. The first
reads the exact proof and inexpensive embedded page evidence. One model analysis
classifies the business opportunity independently of missing contact details. For
GOOD prospects with verified fresh proof and an attributable named business, the
second Actor stage must seek both phone and address before delivery. Rejected
opportunities do not trigger the additional contact lookup. Rows already carrying
both verified fields need no additional lookup.

For a third-party post (for example a town guide promoting another business), the
model may select only a literal business name, event quote and location quote from
the exact post. The Actor re-reads that proof, discards the publisher's contacts,
and checks the target business and location independently. Search rank or name
similarity alone never authorizes copying a publisher's contacts. Ambiguous targets
stay in review. Existing historical results are not silently rewritten.

Contact sources are, in order where available: the matched business page and up to
two public About/contact routes; the business's linked official website and one
same-host contact page; bounded discovery of identity-matched Facebook pages and
official sites. An email alone cannot stop required phone/address work. Exact
first-party post address lines, official JSON-LD postal addresses, and explicit
official address blocks are supported. Missing or ambiguous fields stay blank.
Every accepted field retains its own source URL. Direct site connections reject
private/internal destinations, including DNS results and redirect destinations.

The two Actor stages share the existing COT_ACTOR_MAX_CHARGE_USD allowance equally
(USD 0.10 + USD 0.10 when the existing batch allowance is USD 0.20), with 120/180
second Actor timeouts and automatic restarts off. No extra model analysis occurs
after contact lookup. A failed/uncertain contact run settles the batch in review;
it is not automatically retried. A later deliberately requested validation is a
new paid operation. Lifetime validation counters count API batches, which may now
contain two child Actor runs. The schedule and CONFIG limits are not changed by
this code update.

The batch API includes quality_assessment, contact_lookup and the original
contact_enrichment contract. The cloud snapshot/operational CSV names a resolved
target business; the original publisher remains in the saved lead and snapshot.
Manual CSV exports preserve original columns and add Verified Contact Business
and Contact Lookup Status. READY still requires GOOD quality, verified freshness,
matched event identity, both verified contacts, and no review/conflict flags.

Deployment order: build the validation Actor from this matching source first,
then deploy the backend, controller Actor (including its shared contact modules),
and frontend. This section describes implemented code, not a verified deployment.
The legacy /analyze endpoint remains analysis-only; automatic scraping uses the
existing /validate-batch flow. No destination submission is added.

This worker uses the existing search Actor **53bGXKeIhVmNMTCi4**. It does not
change that Actor or require the browser/frontend to remain open.

```text
One-minute scheduler tick
  -> one bounded keyword-search run
  -> persist raw posts, deduplicate post IDs
  -> COT exact-post validation + observed phone/address evidence
  -> enriched.csv / review.csv / rejected.csv
  -> wait at least five minutes, rotate keyword, repeat
```

The one-minute tick advances an existing cycle. It does not launch a fresh
Actor every minute. Each query is a separate search, not a comma-separated
list. Default searches cover the rolling last 24 hours in the UK. Keywords
in `config.example.json` are editable starter COT queries. A full rotation
takes six completed cycles, including validation time and cooldowns. These
bounded searches do not guarantee exhaustive Facebook coverage.

## What is written

- `output/enriched.csv`: GOOD, freshness-confirmed leads with verified event
  identity, phone and address, their evidence URLs, post ID and validation time.
- `output/review.csv`: missing or conflicting evidence, unresolved identity,
  or uncertain COT/freshness decisions. No invented or AI-guessed contacts.
- `output/rejected.csv`: BAD or deterministically stale leads.
- `output/runs.json`: run status, partial/incomplete search outcome, stopping
  reason and observed Apify cost when available.
- `output/status.json`: counts, backlog, current work and halt reason.
- `data/pipeline.sqlite`: durable raw records, validation responses, dedup
  IDs and counters. Keep it across restarts. It contains business lead data;
  restrict directory access and include it in backups.

These are cumulative, regenerated snapshots, not append-only files. Freshness
and business identity are rechecked at export time; stale or unresolved leads
leave `enriched.csv`. Older model responses without the required search-author
identity evidence stay in review. Each file is
replaced atomically and status is written last, but the set of files is not a
single atomic transaction. Copy after a completed tick for a consistent set.
Source/audit records remain in SQLite. No records are posted to techiesdata.org.
Import phone/post-ID CSV columns as **text** in spreadsheets to preserve zeros
and long IDs. Values are formula-escaped, not executable Excel formulas.

For search imports, a matched publisher page alone does not establish which
business the event concerns. The backend requires an exact caption quote and
matched publisher/business evidence for self-authored events; detected referrals
cannot publish the publisher's contacts as the target business's contacts.
Third-party businesses are not automatically resolved or scraped by handle.

COT batches request `contactRequirements: "phone_address"`. Missing phone/address
evidence can trigger the bounded official-site fallback even if email exists.
Only an unambiguous named UK structured address is accepted from that fallback.
Missing, ambiguous or inaccessible evidence stays blank. Existing callers that
omit this option retain the any-contact policy. Per-field URLs refer to observed
pages; COT no longer constructs unvisited Facebook About links.

## Limits and billing

Defaults: 40 results, 20 pages, 40 requests and 180 seconds per search;
512 MB; $0.10 maximum Apify charge per search. Up to 288 search starts per
UTC day. Validation uses batches of up to three rows, up to 40 calls per UTC
day including retries; the COT Actor is capped at $0.20 and 300 seconds per
call. Thus the configured Apify ceilings are **$28.80 search + $8 validation
per UTC day**. These are ceilings, not expected costs, and exclude OpenAI,
hosting, taxes and platform rounding. Ordinary backpressure typically permits
fewer searches: pending validation is drained before the next search, and
exhausting either daily allowance pauses further starts until UTC midnight.

The client sends `maxTotalChargeUsd` as documented in the
[Apify run API](https://docs.apify.com/api/v2/actors-runs-post). Platform-enforced
caps can stop a run with partial results. No application can promise exact
billing down to the cent. Set lower count/cost limits for initial activation.

No paid work starts from installation alone. Both `enabled: true` in the
configuration and `PIPELINE_LIVE_ENABLED=true` in the scheduler environment
are required. Do not enable without approval for the bounded cloud usage.

## Prepare and verify (no paid calls)

Use **Node 24.2 or newer**, one host and a persistent local filesystem. The
worker uses Node's built-in SQLite API (Node 24 currently emits an experimental
warning). The existing backend can keep its separate supported runtime.

From the backend directory:

```powershell
Copy-Item pipeline/config.example.json pipeline/config.json
npm.cmd run test:pipeline
npm.cmd run pipeline:plan
npm.cmd run pipeline:tick
```

The last command creates empty output snapshots and returns `disabled`.
`config.json`, database, outputs and real `.env` are ignored by Git.

## Production prerequisites

1. Publish the reviewed backend/Actor branch, deploy the **COT** Actor from
   `actor/`, and verify its actual cloned branch/commit. Do not replace the
   keyword-search Actor or a shared client2 Actor. Confirm the COT backend's
   configured `APIFY_ACTOR_ID` before touching that deployment.
2. Deploy the backend with the contact changes and authenticated pipeline
   routes. Preserve existing configuration; add a random `COT_PIPELINE_API_KEY`
   and `COT_ACTOR_MAX_CHARGE_USD=0.20`. After the Actor version and bounded canary
   are verified, set `COT_CONTACT_ACTOR_READY=true`. The key must also be present
   in the scheduler environment. Existing frontend routes are unchanged.
3. Provide the scheduler's `APIFY_API_TOKEN` and matching
   `COT_PIPELINE_API_KEY` securely. Never place secrets in `config.json`, Git,
   scheduled-task arguments, or URLs. The CLI reads `backend/.env`; use the
   template `pipeline/.env.example` as a guide, not as a source of credentials.
4. Use `config.canary.example.json` to prepare a bounded canary: one search,
   at most three results, three pages, eight requests, one validation
   call, no retries beyond that daily call allowance. The Apify ceiling is
   $0.10 + $0.20 = $0.30, plus OpenAI. Inspect live evidence and CSV segregation.
   Local synthetic tests cannot establish live Facebook reliability.
   It uses separate canary data/output directories. Before recurring activation,
   retain the canary database as the initial production database (or point the
   production config at it) so those paid posts and daily counters are not reset.
   Its lifetime limits keep it stopped even across UTC midnight; recurring
   configuration omits those lifetime limits while preserving the counters.
5. After approved activation, enable the scheduler and both runtime switches.
   The worker checks authenticated backend capabilities before any search
   start, including the contract, batch size and validation Actor cost cap.

The backend readiness flag is an operator attestation, not remote inspection
of Actor source. For the first canary, set it only after checking the deployed
Actor commit; leave recurring scheduling disabled until that canary passes.

## Schedule

For the Apify-hosted controller and automatic frontend, use
[cloud/README.md](../cloud/README.md). The following schedules are optional
local alternatives; do not enable both local and cloud controllers.

Windows (this workstation): `pipeline/install-task.ps1` prepares a Task
Scheduler task **disabled**, with a one-minute trigger and IgnoreNew for
overlaps. The script refuses to overwrite an existing task. It requires
explicit invocation; it has not been installed automatically. After approved
activation, enable `Techies COT pipeline` in Task Scheduler. The default task
uses the current user's interactive session; the machine must remain on and
logged in. Configure a service account separately for unattended hosting.

Linux: use `cron.example` with absolute paths. It is deliberately commented
out. SQLite adds an independent process lock even if cron overlaps. Choose
one scheduler only. Store data/output on persistent **local** disk; no network
filesystem or multi-host writers. Do not place this worker on an ephemeral
cron container: it would lose dedup and cost counters. A persistent server or
worker with the same data directory is required for unattended 24/7 operation.

Stop by disabling the task/cron or setting either runtime switch false. An
already-started cloud run is not automatically aborted; its billed work can
finish, and the next enabled tick resumes polling it.

## Recovery and limits

- Live-owner locks never time out. Dead local processes can be reclaimed;
  a lock from another host is not stolen. Do not delete locks while a worker
  is running. PID reuse can conservatively leave a stale lock blocked.
- Lost search-start responses and interrupted validation submissions halt
  without automatic replay. This prevents silent duplicate paid runs. Backend
  replay caches are memory-only, so this is **not** an exactly-once billing claim.
- After checking the Actor console, attach an uncertain search with
  `node pipeline/cli.mjs attach-run RUN_ID`. Actor, start time and input are
  checked. It does not start a run or refund the reserved daily counter.
- After reconciling an uncertain validation, explicitly accept a possible
  charge with `node pipeline/cli.mjs retry-batch --acknowledge-possible-charge`.
  It preserves batch identity and daily/attempt limits. No cloud call occurs
  until the next enabled tick. Automatic retries are limited to the named
  transient 503 codes, with one/two-minute backoff and at most three attempts.
- Fix a non-ambiguous failure, then `node pipeline/cli.mjs resume`.
  This cannot clear an uncertain paid request. Three consecutive incomplete
  searches halt after preserving/processing their available rows.
- The dataset limit is 1,000 items/run; storage halts at 25,000 distinct posts.
  Review disk capacity and archive deliberately. Deleting the database resets
  dedup and spending history; never use that as an automated recovery action.
- Old or blocked contracts cannot supply verified contacts. Missing input
  identities go to quarantine. A failed/partial search is never called an
  empty successful search. Revisited post IDs are skipped; edits to a previous
  post require a deliberate audited revalidation rather than extra auto-spend.

## Verification

### Search Actor v2 contact handoff

Ingestion accepts `facebook-search-posts-v1` and `facebook-search-posts-v2`.
V2 `author.phone` and `author.address` populate the original lead input columns;
the postcode is extracted only from the supplied address. Author identity,
website, email, phone source type and reported confidence are preserved in
`Search Author Contact` (JSON stored as a string for the batch echo contract).
No search-only value is promoted to verified contact evidence. Unknown schema
versions remain rejected.

The current search Actor source records contact values for the post author. It
does not emit field-level verification flags or the exact source URL for each
value; `contactSource` describes the phone and may differ from the address's
source. In particular, publisher contacts cannot serve a promoted business.
Verified output continues to require exact-proof identity/freshness and phone
and address provenance. A matched self-authored page may pass its discovered
website as a candidate to the existing bounded verifier, without treating that
URL as an independently verified page link. Complete verified proof contacts
already skip the second lookup.

`search-contacts.csv` is a separate audit export, including pending rows.
`enriched.csv` keeps verified contacts only. Cloud snapshots expose a bounded,
whitelisted `searchAuthor` object for the dashboard's unverified-contact panel.
This does not rewrite previous saved results or revalidate quarantined rows.
Recover previously quarantined v2 rows only through a separately audited replay
with duplicate and paid-validation checks; never start a replacement search just
to retrieve the same existing dataset.

Optional search input controls now support `maxAuthorRequests` (0–40),
`authorTimeoutMs` (1000–30000), `includeGoogleFallback` (boolean),
`googleFallbackBudgetMs` (10000–90000), and `googleSearchTimeoutMs` (5000–20000).
Omitting them retains the Actor defaults; existing run cost/time ceilings remain
unchanged. This code change does not enable a schedule or alter live settings.

`npm run test:pipeline` covers complete synthetic flow, authenticated HTTP
capability/validation routes, restart/pagination recovery, locks, duplicate
posts, daily caps, ambiguous paid calls, safe retries, row mismatch,
unverified contacts, timestamp provenance, CSV injection and aging outputs.
`npm test` runs the existing backend regression tests. No live provider calls
are made by either suite.
