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

## Environment

Copy `.env.example` and configure:

- `APIFY_API_TOKEN`
- `APIFY_ACTOR_ID` (defaults to `cE441Keduu5udSFbY`)
- `FACEBOOK_COOKIES` as a JSON array string
- `ALLOWED_ORIGINS`
- optional legacy OpenAI settings used by `/analyze`

On Render, use `npm start`. Refresh `FACEBOOK_COOKIES` when the actor reports
`loginRequired: true`.

## Endpoints

- `GET /health`
- `POST /validate-business` — Card-data workflow
- `POST /fetch-results` — structured Apify evidence lookup
- `POST /analyze` — preserved legacy COT/OpenAI workflow

## Local verification

```bash
npm install
npm test
npm start
```

Then send a lead to `http://localhost:10000/validate-business`.
