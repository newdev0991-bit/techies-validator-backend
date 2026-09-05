# Validated search results to Leads Viewer

The cloud controller accepts existing search output through `import-search-plan`
and `import-search-run`, validates it through the existing authenticated COT
batch API, and can deliver READY rows to the existing Leads Viewer ingestion API.
It does not require the validator frontend to remain open.

## One-minute generation cadence

The scheduler checks every 60 seconds, and both configuration templates now use
`searchIntervalSeconds: 60`. After a search/validation cycle finishes, the next
search becomes eligible after a 60-second cooldown. An active run or pending
validation takes precedence; generation does not overlap or guarantee a completed
lead every minute. Existing daily and lifetime spending/count limits still apply.

For the existing cloud deployment, merge only `searchIntervalSeconds: 60` into
its current CONFIG record, preserving all other settings, counters and state.
The prepared Apify schedule already ticks every minute. Updating local templates
does not update live CONFIG or enable its paused schedule. Live activation and
the recurring budget remain outstanding.

The destination contract was checked against `newdev0991-bit/techies-data-pipeline`
commit `566eeca`. The nine display headers match `leads (54).csv`. Original proof
text and URL are retained; company, phone and full address come from the current
identity/contact assessment. Address 2 and Phone 2 remain blank unless separately
supported; the full verified address is not guessed into street/town components.
Post IDs, proof date and evidence URLs remain in the raw ingestion payload.

## Operator configuration

Set these on the controller, never in browser code or Actor input:

```
TECHIES_DELIVERY_BASE_URL=https://YOUR-INGESTION-BACKEND
TECHIES_DELIVERY_SOURCE=MFULL
TECHIES_DELIVERY_TOKEN=<destination PIPELINE_API_TOKEN>
TECHIES_DELIVERY_ENABLED=false
TECHIES_DELIVERY_QUEUE_REVIEWED=false
```

MFULL above is an example, not an assigned source. NFULL is also supported.
The website URL is not necessarily the ingestion backend URL. Confirm its current
server-side proxy configuration before selecting the destination origin.

Run `delivery-plan` to inspect the exact payload without writes. For a deliberate
delivery-only invocation use `operation: deliver-ready`, `enabled: false`; sending
also requires both delivery switches true and the destination token. Normal
enabled controller ticks deliver at most three READY rows each after completing
their existing step. Disabled ticks, imports and recovery do not auto-deliver.

**Existing destination behavior:** post-cutover ingestion can enqueue validation
jobs again. Before setting QUEUE_REVIEWED=true, verify whether its validation
worker is disabled or approve that extra cost. This integration does not assert
APPROVED in the destination database or bypass that destination's own policy.
The existing read API can display the ingested records in the supplied layout;
its source, status and duplicate filters still apply.

Receipts persist in the existing controller state and survive restarts. Only
COMPLETED acknowledgments with one received row and zero errors count as delivery.
A lost response or interrupted checkpoint is held for manual reconciliation by
its Idempotency-Key; do not clear receipts to retry. Confirm the destination run
and linked master first. The existing destination retains failed idempotency keys,
so replay alone does not repair partial imports. A READY lead that has expired is
not newly delivered. Previously delivered leads are not automatically deleted.

## Supplied run

`6XiZUAEOTlhC1pldw` succeeded with 80 rows in dataset `3UXdhxykUEzi2t1qS`.
Import must first satisfy the existing input/summary/schema checks. Supply the
exact observed `expectedSearchInput` in the import-only Actor input to accept its
different query and completed-run limits without changing future search CONFIG.
Reuse this dataset rather than starting a replacement search. Paid validation,
production deployment, source choice and live destination credentials still need
to be resolved before live activation. No production writes were made in this change.
