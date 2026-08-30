# Techies Validator Backend

Express backend for the Techies validator. The default workflow implements
Card-data's business-activity rules and uses the private Apify Facebook actor for
source evidence.

## Card-data validation contract

`POST /validate-business` accepts one lead at a time:

```json
{
  "profile": "card-data-business-activity",
  "lead": {
    "Name": "Example Roofing",
    "Category": "Roofing Service",
    "Link": "https://www.facebook.com/example",
    "Address": "Example Street",
    "Country": "United Kingdom",
    "ZIP": "AB1 2CD",
    "Phone": "",
    "Owner Name": "",
    "Email": "",
    "Comment": "",
    "Pass/Fail": ""
  },
  "knownDuplicateKeys": []
}
```

The response contains the normalized lead, a deterministic verdict, evidence,
reason codes, and a CSV-ready record. Verdicts are:

- `PASS`: active/trading independent business with qualifying evidence inside
  the 183-day activity window.
- `FAIL`: inactive outside the window, closed, duplicate, franchise, chain, or
  large business.
- `MANUAL_REVIEW`: Facebook blocked the scrape or the evidence was insufficient
  or contradictory, including when the submitted business name cannot be
  matched reliably to the scraped Facebook page identity.

The service does not convert missing evidence into a PASS or FAIL.

Scraped email addresses are accepted only when the actor marks them as coming
from a `mailto:` link or an explicitly labelled email field inside the
business-page contact area. Email text found elsewhere in the authenticated
Facebook interface is discarded. Emails supplied in the input CSV remain
trusted as submitted data.

## Legacy COT freshness safety

`POST /analyze` and its `/validate` alias preserve the legacy response envelope
(`content[0].text`) while applying deterministic freshness rules after the
OpenAI assessment:

- exactly 24 hours old is fresh; anything older is stale;
- scraped ISO, scraped raw date, and `Lead Posting Date` are parsed separately
  and retained as timestamp candidates with provenance;
- actor slash-form dates are always parsed explicitly as UK `DD/MM/YYYY` in
  `Europe/London` (including daylight saving time);
- `Lead Posting Date` uses `LEAD_DATE_ORDER` because the current COT
  Google Forms/Sheets export is `MM/DD/YYYY`;
- materially conflicting sources, future timestamps beyond the five-minute
  skew allowance, imprecise boundary dates, and untrusted scraper provenance
  return `UNCLEAR` with `needs_manual_review: true` and can never auto-reject;
- a stale lead is auto-rejected only from a trusted, sufficiently precise
  timestamp.

For group-feed URLs, actor evidence becomes trusted only when the actor reports
a successful scrape plus `time_target_matched: true` and
`time_confidence: "high"` or `"medium"`. Precision is read from
`time_precision` plus `time_is_estimated`/`time_estimated`. The backend also supports the structured
`timestampProvenance` equivalent. An estimated or date-only range may establish
`FRESH` only when its entire possible interval is within 24 hours. Ranges that
cross the boundary remain `UNCLEAR`, and only high-confidence exact machine
timestamps can cause a stale auto-rejection. Freshness responses retain the original
fields and add `decision`, `autoRejectEligible`, `requiresManualReview`,
`reasonCode`, `warnings`, `source`, `confidence`, and `candidates`. When evidence
is unresolved, `timestamp` and top-level `posted_at` are `null` so clients do
not present a disputed scrape value as canonical.

## Environment

Copy `.env.example` and configure:

- `APIFY_API_TOKEN`
- `APIFY_ACTOR_ID` (defaults to `J8wBqFJa8GQo9RJ5J`)
- `APIFY_WAIT_SECS` (legacy single-row wait, bounded to 10-300 seconds)
- `APIFY_BATCH_WAIT_SECS` (strict batch wait, defaults to 300 seconds)
- `APIFY_ACTOR_CONTRACT=cot-data-batch-v1`
- `COT_BATCH_SIZE` (defaults to 3; maximum 10)
- `COT_ACTIVITY_WINDOW_DAYS` (defaults to 1; final freshness is still reconciled at exactly 24 hours)
- `COT_BATCH_CACHE_TTL_MS` (successful response/evidence replay window; defaults to six hours)
- `ALLOWED_ORIGINS`
- `LEAD_DATE_ORDER` (`MDY` for the current source sheet; `DMY` for a UK-formatted source)
- optional legacy OpenAI settings used by `/analyze`, including `OPENAI_TIMEOUT_MS`
- optional `RATE_LIMIT_MAX` (defaults to 60 requests per minute per client)

On Render, use `npm start`. The Actor in `actor/` uses logged-out HTTP and does
not accept or require Facebook account cookies. Existing cookie environment values
are ignored. See `actor/COT-PORT.md` for the pinned reference and COT proof rules.

## Endpoints

- `GET /health`
- `POST /validate-business` — Card-data workflow
- `POST /fetch-results` — structured Apify evidence lookup
- `POST /analyze` — preserved legacy COT/OpenAI workflow
- `POST /validate-batch` — strict COT batch workflow with stable row identity and idempotent replay

`POST /validate` is an alias for the legacy `/analyze` endpoint. `/fetch-results`
also returns the reconciled `freshness` object and `needsManualReview` flag.

`POST /validate-batch` accepts one to `COT_BATCH_SIZE` rows. One Actor run handles all
Facebook rows in the batch, Actor output is joined only by `requestKey`, and successful evidence
is checkpointed before concurrent OpenAI analysis. Retrying the same `batchId` reuses completed
work; reusing it with a different payload returns a conflict.

All endpoint failures use a stable JSON shape and do not expose provider
payloads, credentials, or stack traces:

```json
{
  "error": {
    "code": "INVALID_LEAD",
    "message": "The \"lead\" field must be a JSON object."
  }
}
```

## Local verification

```bash
npm ci
npm test
npm start
```

Then send a lead to `http://localhost:10000/validate-business`.
# COT contact enrichment

`/analyze` (inside `content[0].text`) and `/validate-batch` now return
`contact_enrichment` with schema `cot-contact-enrichment-v1`. Phone, address,
and postcode each include their observed value, verification state, evidence
URL, submitted value and conflict flag. Values are derived from matching Actor
evidence, never generated by the model. Only missing input fields are filled
for analysis; submitted values are retained and conflicts require review.

Deploy the corresponding COT Actor changes in `actor/` to emit explicit
address provenance. Legacy Actor address fallbacks are deliberately withheld.
The contact state does not alter the existing COT freshness verdict. This is
an enrichment API, not authorization to publish a lead or skip duplicates.
