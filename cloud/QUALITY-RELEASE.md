# COT quality and recovery release

## Contract and operation

Publish the compatible frontend before the backend, evidence Actor and controller.
The controller emits `cot-cloud-results-v2`; the frontend accepts v1 and v2. Ready
still requires the existing 24-hour freshness rule, proved business identity and
verified, non-conflicting phone/address. Exactly 24 hours remains eligible; older
exact proof is EXPIRED when underlying quality is not BAD. BAD stays REJECTED.
Uncertain dates stay in review. Reading/exporting recomputes status but never writes
a new original validation time or changes historical Ready-at-validation yield.

Dashboard defaults to Ready, newest proof first. All categories remain available.
Operational pipeline exports include `expired.csv`, original validation status,
freshness and address-conflict evidence. Publisher contacts remain separate.

Every search cycle records raw/filtered/duplicate/validated counts, Ready at
validation, unresolved contacts and available search cost. Keyword totals aggregate
saved cycles. Historical missing duplicate counts or costs remain unknown. Samples
below 20 validations are labelled small; this is a warning, not statistical proof.
Validation/model/overhead costs remain unavailable unless separately reconciled.

`pipeline/config.experimental.example.json` contains the six requested queries in
fixed rotation. It is disabled and retains the inspected lifetime limits of 8
searches and 33 logical validation calls, daily limits 3/14, and existing per-call
ceilings. It is an example, not a command to overwrite the current CONFIG. Copy only
the queries into the current configuration after reviewing any intervening edits.
Do not reset query history, dedup, counters or replay archived candidates.

## Verified bounded-search recovery

Only PAGE_BUDGET_EXHAUSTED and REQUEST_BUDGET_EXHAUSTED can qualify as bounded partial
results. They stay partial, never complete. Summary query/count/limit evidence must
match the saved input and terminal run, with a positive accepted result count.
Malformed rows halt before validation. Real failures still accumulate; unknown
paid operations, mismatched runs and corrupt state retain their existing halts.

In the controller's Input, retain the existing state store and lock queue and turn
Allow processing off. Choose `recovery-plan` first. This reads the relevant provider
runs, original inputs, summaries and bounded dataset pages; it starts no child Actor.
Read OUTPUT.recovery. Applying `recover-bounded-searches` re-verifies the evidence
under the same cloud lease. It refuses any pending cycle/batch, insufficient history,
wrong run/storage/Actor, malformed dataset or non-limit failure.

Apply preserves all run/lead history and spending counters. It clears only the
eligible halt and consecutive failure count and saves a recovery audit. At 8/8
searches, it still cannot start another search. A dry run does not modify STATE;
it can publish derived RESULTS and its own report. Controller invocations themselves
can incur normal platform/storage charges even when no child Actor runs.

Local equivalent: `node pipeline/cli.mjs recover-bounded-searches` reports the plan;
append `--apply` only with processing disabled. This affects only the configured
local database, never the named cloud state. Do not initialize replacement storage.

## Offline evidence replay

Run `node scripts/replay-cot-quality.mjs <saved-evidence.json> <evaluation-ISO>`.
Input contains retained `leads`, `runs`, and `quarantine` rows from the existing
store. Keep this private evidence outside Git. Replay imports no providers and makes
no paid requests. Synthetic regressions cover the named observed failures.

The 74-row saved sample, evaluated at 2026-09-02T17:03:03.646Z, originally contained
6 Ready, 38 Review and 30 Rejected at their individual validation times. Local replay
produced 0 Ready, 37 Expired, 3 Review and 34 Rejected at the fixed snapshot clock.
This is reclassification, not a new validation or an increase in live yield.

- SE Medical: normalized literal apostrophe quote and retained multiline address.
- Deeside Kilts: extracted the `premises @ 16A Bridge Street` address.
- Corinium: corroborated the legal-name variant but preserved conflicting addresses.
- Galloway Jennings and Daisy Bonny & Beau: retained their opening announcements.
- Surrey Family Vets: excluded its anniversary-only retrospective.
- Eight saved searches: five bounded partial, three complete. Recovery still requires
  fresh read-only verification of the relevant original runs before clearing a halt.

## Proposed live canary - approval required

Do not run automatically. First verify all released commit IDs, current CONFIG,
remaining allowances, controller history, and that no operation remains uncertain.
Use the existing storage/dedup; pause the recurring schedule for the bounded test.
One new search, query `our new premises`, maxResults 3, maxPages 3, maxRequests 8,
pageSize 10, timeout 180 seconds, 512 MB. At most one logical validation batch of
3 new candidates; maxValidationAttempts 1, existing validation timeout 600 seconds.

The child-Actor charge ceilings are $0.10 for search plus $0.20 for the logical
validation batch (proof and contact phases split that allowance): $0.30 combined.
This is not an all-inclusive price estimate. Model tokens, controller invocations,
compute/storage and platform behavior can add costs; reconcile before approving a
total spend ceiling. Stop after one cycle or any uncertainty, even with zero Ready.
At the inspected 8/8 lifetime searches, approval must explicitly authorize raising
the search ceiling to 9, never resetting usage. Preserve the validation ceiling of
33 if current usage leaves room; otherwise request an explicit additional allowance.
No historical paid replay, automatic further runs, or external lead submission.
