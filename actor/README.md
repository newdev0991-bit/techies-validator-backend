# Techies Facebook card-data scraper

Apify Actor used by the Card-data validation backend. It opens Facebook with the configured
authenticated session, verifies that the target page belongs to the submitted business, collects
trusted business-authored activity evidence, and optionally enriches contact details.

The backend and Actor are one versioned integration. Every dataset row declares:

```text
schemaVersion:   card-data-v1
contractVersion: card-data-batch-v1
source:          facebook
```

The backend rejects any missing or incompatible contract instead of guessing how to map or trust
the result.

## Batch input

Production callers use `requests`, with one stable key and lead identity per row:

```json
{
    "cookies": "[{\"domain\":\".facebook.com\",\"name\":\"c_user\",\"value\":\"...\"}]",
    "activityWindowDays": 183,
    "maxPosts": 3,
    "requests": [
        {
            "requestKey": "row-0",
            "url": "https://www.facebook.com/example",
            "lead": {
                "name": "Example Roofing",
                "category": "Roofing",
                "address": "Liverpool"
            }
        }
    ]
}
```

`requestKey` values must be unique. Each output echoes its `requestKey` and original `inputUrl`, so
out-of-order Actor dataset items cannot be assigned to the wrong lead. Legacy `url`, `urls`, and
`startUrls` input is retained for manual runs, but the backend does not depend on its positional
mapping.

See [.actor/input_schema.json](.actor/input_schema.json) for all options. The production defaults
use a sticky residential Facebook session, three recent posts, and skip contact/Google enrichment
only when inactivity is already proven.

## Precision rules

- Activity requires a verified page identity or independently attributed business-authored story
  card. General page text and OCR date strings do not prove a post.
- The 183-day boundary uses exact elapsed milliseconds. Future dates are ignored.
- An automatic inactive result requires a complete, unambiguous feed scan. Scroll limits,
  timeouts, unresolved authorship, or navigation errors leave the scan incomplete.
- A would-be inactive bare page is reloaded and scanned a second time with a deeper bounded sample.
  Both passes must complete; a newer post from either pass prevents the inactive shortcut.
- Page identity is established before the inactive shortcut. The lead name is never copied into
  the observed page name merely to force a match.
- Login walls, checkpoints, and row errors are terminal for that row and never launch Google
  fallback or produce trusted evidence.

The `activity.attribution` and `activity.scan` objects explain the decision, including completion,
stopping reason, warning, trusted/rejected counts, and scan passes. `scrape.success`, `scrape.partial`,
`scrape.blocked`, and `scrape.scrapedAt` let the backend distinguish genuine page results from
transport or contract failures.

## Local checks

```bash
npm install
npm test
node --check src/main.js
```

The test suite covers batch identity, duplicate keys, output contract metadata, exact activity
boundaries, scan completion, inactive corroboration, auth/error short-circuits, and OCR identity
guards without making a paid Actor run.

## Deployment order

Deployment order is mandatory:

1. Build and deploy this source to the Actor ID configured as the backend's `APIFY_PAGE_ACTOR`.
2. Run a bounded canary and confirm every dataset row reports `card-data-batch-v1` with the echoed
   `requestKey` and `inputUrl`.
3. Deploy the backend, then confirm `/health` reports the same contract and intended batch size.
4. Deploy the frontend last.

If the backend is deployed before this Actor contract, it intentionally returns a top-level
contract failure rather than silently misattributing evidence.
