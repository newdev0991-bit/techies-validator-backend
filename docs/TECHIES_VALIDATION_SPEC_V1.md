# TECHIES_VALIDATION_SPEC_V1

Source of truth for lead validation. It covers the current validator (v1) and
the rebuild (v2, in `src/v2/`). Where this spec and the code disagree, the code
is wrong and gets a ticket.

Status: **draft for owner sign-off** (2026-09-24). v2 runs in **shadow mode
only** and does not affect delivery.

---

## 1. Pipeline

```
Facebook Search Actor ─► Stage 1 RULES (free JS) ─► Stage 2 EVENT AI (gpt-5-nano)
                              │ REJECT                    │ UNCERTAIN
                              ▼                           ▼
                           rejected              gpt-5-mini (same prompt)
                                                          │ still UNCERTAIN
                                                          ▼
                                        evidence recovery ─► human review
Then, deterministic and shared with v1: freshness · identity · contacts ─► statuses
```

A strong model never sees an obvious case. Web-browsing AI (`WEB_VERDICT`,
`WEB_CONTACT_RECOVERY`) is a last resort only and stays OFF by default. This
follows the 2026-09-11 cost incident.

## 2. What a good lead is

A **COT opportunity** is a real premises event for a UK commercial business:

| Qualifies | Does not qualify |
|---|---|
| new opening / opening soon | routine reopening (same owner, same site) |
| relocation to new premises | same-site expansion (knock-through, more seating) |
| genuine second site (first one stays) | minor update: menu, prices, decor, equipment, staff |
| ownership / operator change | closure with no continuing premises |
| active search for premises (before a lease) | personal, housing, job or recruitment posts |

Post age never decides whether something is an opportunity; it only gates delivery (see §5 D1).

## 3. Separate outputs, not one GOOD/BAD

| Output | Values | Decided by |
|---|---|---|
| **Opportunity** | QUALIFIED · NOT_QUALIFIED · UNCERTAIN | Stage 1 exclusions + Stage 2 event |
| **Identity** | VERIFIED · THIRD_PARTY_NAMED · THIRD_PARTY_UNRESOLVED · UNRESOLVED | `cot-identity.js` + model's `about` |
| **Eligibility** | ELIGIBLE · INELIGIBLE (+reasons) | Stage 1 rules |
| **Contact** | COMPLETE · PHONE_MISSING · UNAVAILABLE · CONFLICT | `cot-contacts.js` |
| **Delivery** | READY · NOT_READY · REVIEW · REJECTED | code, from the four above + freshness |

Rules:
- A missing phone makes a lead **NOT_READY → contact recovery**. It is never
  BAD. A direct phone is required for READY, and an address alone does not count.
- `REJECTED` happens only when the business is not qualified or is ineligible.
- A legacy `verdict` (GOOD/BAD/UNCLEAR) is derived for old clients and for
  comparison.

## 4. Stage 1: deterministic rules (`src/v2/rules.js`)

**Reject only near-certain cases:**
- banned postcode areas: BT, IM, GY, JE; Eircode or Republic of Ireland place names
- prohibited Industry Type: education, legal, non-commercial (matched on the
  field only, not the caption)
- exact-name national chains (list in code)
- excluded events from `cot-events.js`: historical, personal or employment move,
  recruitment-only
- duplicates

**Computed as facts for the model, never as a rejection on their own:**
keyword flags for opening, relocation, ownership, second site, premises search,
minor update and routine reopen; the size of the post sample (a bounded sample,
never a lifetime count); page maturity, which is always `unknown`; the postcode
area.

A missing caption gives `NEEDS_EVIDENCE`, which goes to review.

## 5. Contradictions found in the current code (to resolve)

| # | Contradiction | Where | Proposed resolution |
|---|---|---|---|
| D1 | **Two freshness rules.** Prompt/`applyFreshnessPolicy`: age is a priority, not a gate. Pipeline: stale proof → `EXPIRED`. | `src/freshness.js:920`, `pipeline/records.mjs` | ✅ **Resolved:** age never decides the *opportunity* verdict, but it gates *delivery* (stale → EXPIRED). One switch, `FRESHNESS_GATE` (default on), used by v1 pipeline and v2. |
| D2 | **Two thresholds.** Code 24 h; prompt text said 48 h. | `freshness.js:5`, `server.js` prompt | ✅ **Resolved:** 48 h wording removed from the prompt; 24 h in code is the only threshold. |
| D3 | **Verdict enum mismatch.** Model returns MAYBE/NOT_A_LEAD; pipeline accepted only GOOD/BAD/UNCLEAR → whole batch failed with `BATCH_CONTRACT_MISMATCH`. | `pipeline/records.mjs` | ✅ **Fixed (owner decision):** MAYBE → UNCLEAR, NOT_A_LEAD → BAD via `toContractVerdict`; raw model value kept as `ai_verdict`. |
| D4 | **Hard exclusions existed only in the prompt.** Banned postcodes, education and chains were enforced nowhere in code. | `server.js` prompt | Moved into Stage 1. |
| D5 | **The AI computes values code can compute.** `caption_analysis.*_keywords` and `post_history_analysis.total_posts` are asked of the model and then overwritten by code. | `buildPrompt` | v2 computes them in code and passes them in. |
| D6 | **Excluded events are applied twice.** | `finalizeCotAnalysis` and `records.assess` | v2 applies them once, in Stage 1. |
| D7 | **Legacy campaign vs spreadsheet eligibility paths.** These are not in this repo. They live in `techies-standalone-leads` (vendored `src/`). | other repo | Audit there. The v2 Eligibility output becomes the single definition. |

## 6. Stage 2: the AI's one job (`src/v2/event-classifier.js`)

> What real-world business event is this Facebook post describing, and is the
> event actually about this business?

- **Output:** `event_type`, `about` (self, third_party or unknown),
  `business_name`, `evidence_quote`, `location_quote` and `confidence`.
- **Code** turns that output into PASS, FAIL or UNCERTAIN:
  - A qualifying event needs a literal quote and confidence of at least
    `V2_PASS_CONFIDENCE` (75).
  - A quote the model invented gives UNCERTAIN.
  - `ambiguous` gives UNCERTAIN.
- **Models:** `V2_MODELS=gpt-5-nano,gpt-5-mini`, with `reasoning_effort=minimal`.
  The chain escalates only on UNCERTAIN.
- **Prices (USD per 1M tokens, input/output):** nano $0.05/$0.40,
  mini $0.25/$2.00. Check these against OpenAI's current pricing before
  quoting costs.
- **Claude and Gemini:** benchmark them only if OpenAI loses on the hard cases.
  Even then, use them as a second-level judge only.

## 7. Benchmark (`scripts/v2-benchmark.mjs`)

- **Dataset:** 300–1,000 labeled rows. Required columns: `label`
  (GOOD, BAD or REVIEW) and `Post Caption`. Optional: `deal`, `v1_verdict` and
  any lead fields.
- **Label mix:** historical DEALS, confirmed good leads, confirmed bad leads and
  hard manual-review cases.
- **Metrics:**
  - recall, including leads sent to review
  - precision
  - false negatives (lost real leads)
  - false positives
  - review rate
  - **deal recall**
  - cost per 1,000 leads
  - latency
  - escalation count
- **Win condition:**
  - deal recall of at least v1's
  - recall (including review) of at least v1's
  - precision within 2 points of v1
  - lower cost per 1,000
  - review rate no higher than +5 points

## 8. Rollout

1. `VALIDATOR_V2_SHADOW=on` on Render. Each analyzed lead also runs v2 and logs
   `[shadow-v2] {json}`. The result is attached as `shadow_v2`, and delivery
   still reads v1 only.
2. After about one week, export the logs and run
   `node scripts/v2-compare-shadow.mjs logs.txt --out disagreements.csv`.
3. Label the disagreement rows by hand (OLD GOOD / NEW BAD, and so on), starting
   with any that became deals. Add them to the benchmark dataset.
4. Switch production only once the benchmark wins (§7) and the owner signs off.

## 9. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VALIDATOR_V2_SHADOW` | off | Run v2 beside v1 |
| `V2_MODELS` | `gpt-5-nano,gpt-5-mini` | Escalation chain |
| `V2_PASS_CONFIDENCE` / `V2_FAIL_CONFIDENCE` | 75 / 75 | Stage 2 thresholds |
| `V2_REASONING_EFFORT` | minimal | GPT-5 reasoning effort |
| `FRESHNESS_GATE` | on | Stale proofs are EXPIRED; `off` delivers them at low priority |
| `V2_SHADOW_TIMEOUT_MS` | 40000 | Upper bound on shadow time per lead |
| `V2_SHADOW_LOG_PATH` | unset | Optional JSONL file |

## 10. Plan tracker (16 tasks)

| # | Task | Status |
|---|---|---|
| 1 | Freeze and document the rules | ✅ this document; D1–D3 resolved |
| 2 | Define a good lead as separate outputs | ✅ §2–3, `src/v2/validate.js` |
| 3 | Ground-truth dataset | ⏳ **needs data from owner** (format in §7) |
| 4 | Analyze historical deals | ⏳ blocked on #3 |
| 5 | Move deterministic checks out of the AI | ✅ `src/v2/rules.js` |
| 6 | The AI's one job | ✅ `src/v2/event-classifier.js` |
| 7 | Benchmark v1 | ✅ harness built; run needs #3 |
| 8 | Test GPT-5 nano | ⏳ harness ready; run needs #3 and the API key |
| 9 | Test GPT-5 mini | ⏳ same run as #8 (`--configs`) |
| 10 | Claude, only if needed | ⏸ conditional on #8 and #9 |
| 11 | Escalation system | ✅ nano → mini → recovery → human |
| 12 | Redesign contact and evidence recovery | 🔜 reuse Google fallback first; web AI stays last resort |
| 13 | Optimize the Search Actor separately | 🔜 pagination, stopping and dedupe (`last_hour` is filtered locally) |
| 14 | Shadow run | ✅ `src/v2/shadow.js`, off by default |
| 15 | Compare disagreements | ✅ `scripts/v2-compare-shadow.mjs` |
| 16 | Switch production | ⏸ only after #7 wins and sign-off |
