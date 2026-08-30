# Local COT identity and contact fixes

Branch: `codex/cot-identity-contact-fixes`, based on `1c7933e`.
This continuation did not push, deploy, start paid providers, or enable a scheduler.

## Behavior

- Search-result authors remain candidates until exact proof supports the business
  responsible for the event. Detected third-party promotions turn GOOD into
  UNCLEAR and withhold publisher contacts. Existing BAD decisions remain BAD.
  Export rechecks identity, including older saved responses lacking identity proof.
- The prompt no longer treats 9–10 sampled posts as a lifetime total or evidence
  of a young page. Page maturity stays unknown, including in model responses
  that ignore the prompt. No education/industry eligibility policy was changed.
- COT requests missing phone/address evidence even when email exists. A matched
  homepage can lead to one same-host contact page; redirected unrelated sites
  cannot inherit its identity. Home and contact-page values keep separate URLs.
- Official-site addresses require a named, complete UK structured address. Multiple
  plausible addresses, mismatched names/postcodes and incomplete data stay blank.
- COT contact provenance uses actually read pages, preserving profile IDs and
  replacing fabricated About links in both fields and evidence lists.

The fallback retains its existing 30-second ceiling, at most two search queries,
two candidate hosts per query and one contact-page follow-up per candidate.
The explicit COT mode may do more work than before for email-only rows; it does
not change Actor run caps, batch sizes, retries or durable charge counters.

## Verification

227 offline tests passed: 77 backend, 103 Actor, 17 pipeline and 30 unchanged
frontend tests. The changed contact modules passed ESLint; Actor entrypoint
syntax and Git whitespace checks passed. Regression coverage includes a valid
self-authored lead reaching enriched CSV, and complete publisher contacts being
withheld despite an older GOOD answer. These checks make no provider calls.

The separate offline replay used the saved live response at the original export
time, `2026-08-30T14:26:36.292Z`. It reuses old model answers, not a fresh model run:

| Candidate publisher | Old verdict | Offline policy verdict | Disposition |
| --- | --- | --- | --- |
| Love Taunton - Discover Taunton | GOOD | UNCLEAR, third-party | Review |
| Halal Dining MCR | GOOD | UNCLEAR, third-party | Review |
| Snuggle and Grow Childcare | BAD | BAD, identity unresolved | Rejected |

The replay returns **0 ready, 2 review, 1 rejected**. It cannot recover missing
contacts or prove live fallback success. Original canary database, response,
CSVs and counters remain unchanged. Source response SHA-256:
`668532b6b60b8b3e6281a0bcf3564614d19beb5d0c50d89214eac12e76e9087b`.

Reproduce locally from the backend directory (output must be separate):

```powershell
node scripts/replay-cot-evidence.mjs pipeline/canary-data/validation-response.json ../OFFLINE-REPLAY-2026-08-30.json 2026-08-30T14:26:36.292Z
```

## Remaining live verification

Deploy the backend and Actor from the same reviewed commit, verify both deployed
commit IDs, then use separately authorized bounded testing. Prefer at least one
genuine self-authored opening with known public contacts and one publisher
negative control. Do not reset or reuse the consumed canary's authorization,
database or counters. Recurring operation remains disabled pending live evidence
and authorization for ongoing costs. No third-party target profiles or operational
contact details were inferred or invented.
