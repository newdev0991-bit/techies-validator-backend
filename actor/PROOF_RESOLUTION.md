# COT proof resolution: local verification

Branch: `codex/cot-proof-resolution`. No deployment performed.

## Behaviour

- Normalize exactly one group `multi_permalinks` ID to a direct post URL. Reject multiple/conflicting IDs.
- Read exact public post documents as well as public page timelines. Dates must belong to the same structured story object as the permalink.
- Resolve alternate post IDs only through Facebook's metadata for the requested document. Never use similar captions, dates, or business names as identity proof.
- Resolve reels to a public parent page only through an explicit canonical video URL identifying the same media object.
- Retain preview-only evidence separately. Previews never establish timestamps or masquerade as full captions.
- Preserve the working page-post path, bounded batch identity, retries, no-account-cookie operation, and fail-closed timestamp conflicts.
- Missing/rejected history is unknown (`total_posts: null`), not zero. Nonempty counts describe only the supplied sample, not a lifetime total. Remove unsupported missing-history claims from the AI's displayed explanation and factors.

## Live local smoke check (2026-08-27)

Executed the actual Actor entrypoint locally on the four supplied proof URLs, with account cookies absent, public HTTP only, Google fallback disabled, no paid Apify run, and no AI request. All four output rows had successful scrape status, matched target proof, exact timestamps, and nonempty captions.

| Proof | UTC timestamp returned | Caption characters |
| --- | --- | ---: |
| The Fry Lab group post | 2026-08-26T23:49:24.000Z | 982 |
| The Wellbeing Salon / Wennie Devilliers | 2026-08-27T07:31:25.000Z | 574 |
| Centre Stage Property Staging reel | 2026-08-27T07:24:44.000Z | 882 |
| Treorchy Tool Hire / Advasign | 2026-08-26T21:14:38.000Z | 894 |

The saved Actor outputs also passed the backend freshness evaluator and the unchanged frontend freshness normalizer as fresh at the report's reference time (`2026-08-27T15:06:15Z`). This validates extraction/freshness only, not new AI business-quality verdicts. Future runs must evaluate against their actual current time.

Public responses can vary: preview-only or unavailable responses still require review. Tests cover that failure path as well as successful group/reel/alias resolution, unrelated redirects, unsafe URLs, conflicts, and missing history. A cloud canary on the intended deployed build remains necessary after publication is authorized.

Run regression suites with `npm test` in this directory and its parent backend directory. Local smoke inputs/results are outside Git under the workspace `tmp/cot-proof-local-smoke-20260827` directory; do not publish them as operational exports.
