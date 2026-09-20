# Techies pipeline: 0% contact-yield investigation — full session summary

## Context / pipeline architecture

Three repos:
- **techies-facebook-keyword-search** — search Actor (Apify) that finds candidate Facebook posts.
- **techies-validator-backend** (github: newdev0991-bit/techies-validator-backend) — Express API + OpenAI validation + a second Apify Actor that scrapes Facebook post/page evidence (identity, contacts, timestamps).
- **techies-standalone-leads** (github: zachary3111/techies-standalone-leads) — SQLite-backed dashboard/runner that imports validated leads, vendors copies of validator-backend's `src/`/`pipeline/`/`actor/` code under `vendor/`.

Deployed on Render:
- `techies-validator-backend` — service `srv-d50ag05actks73f002n0`, branch `fix/self-post-timestamp-inconclusive`, autoDeploy off.
- `techies-standalone-leads` — service `srv-dae2l8f40ujc73di0q90`, autoDeploy off, SQLite DB at `/app/state/pipeline.sqlite` (built-in `node:sqlite`, not better-sqlite3).

Claude's GitHub App has **read-only** access to `techies-validator-backend` — all fixes there were delivered as patch files / pasted file contents for the user to apply and push themselves (git am kept failing on Windows due to line-ending mismatches; ended up just pasting full file/diff content for manual paste). Claude has **push access** to `techies-standalone-leads`.

## The problem (handoff)

Since ~2026-09-14, virtually every newly-validated lead landed in `contacts.unavailable` — the contact-enrichment stage was not finding/keeping phone or address data, defeating the purpose of the pipeline even though search and validation both worked. Handoff's own hypothesis: identity resolution (`identity.unresolved`/`third_party` growth) correlates with `contacts.unavailable` growth, but explicitly flagged as "correlational only."

## Key code mechanism traced

`techies-validator-backend/src/cot-contacts.js`'s `enrichCotContacts()` has a top-level `usable` gate:
```js
const usable = sameRow && isSuccessfulFacebookScrape(raw)
  && !raw.scrape?.blocked && !raw.scrape?.loginRequired && !raw.scrape?.notFound
  && !raw.business?.wrongBusiness && !businessIdentity?.requiresManualReview;
```
`businessIdentity` comes from `evaluateCotIdentity()` in `src/cot-identity.js`. Unless status is `matched` or `not_required`, `requiresManualReview` is true and `usable` is false — no phone/address can ever be promoted, regardless of whether the Actor actually found verified contact data.

## Ground-truth investigation (via dashboard `/api/lead?id=` and direct SQLite queries in the Render shell)

Pulled real production leads to see exactly which condition in `evaluateCotIdentity()` was failing. Found **three distinct, independent failure patterns**, not one:

### Pattern A — Timestamp inconclusive (rare: ~0.8% of stuck leads)
Example: "CJTrims" — Page identity matched, self-event wording matched, but `time_target_matched: false` with `proofRetrieval.reason: 'target-not-in-public-sample'` (Facebook's logged-out response for the exact submitted post simply didn't expose a dated story node — traced through `actor/src/cotProof.js`, `cotDocument.js`, `facebookTimelineFeed.js`; concluded this is a Facebook-side gap, not a fixable parser bug). The identity code required `time_target_matched === true` as a hard AND condition even when business identity was otherwise fully confirmed, conflating "is this the right business" with "can we prove exactly when this posted."

### Pattern B — Self-event wording too narrowly scoped to the model's trimmed quote (dominant: ~66% of stuck leads before fix, largest single bucket)
The model's `evidenceQuote` is often a paraphrase that trims out the pronoun that would make it self-referential. Example: "Apex Injury Clinic" — model quoted `"Apex has moved to Jungle Gym Salhouse"`, but the actual caption was `"...a move to new premises! We're excited to share that Apex has moved..."` — the self-referential "We're" sits a few words before the quote, in the same paragraph, but the old code only tested the wording regex (`selfEvent`) against the trimmed `quoted` string itself, not its surrounding context.

### Pattern C — Facebook Group posts have no Page identity at all (~17% of stuck leads)
"Tia Wesley" example: proof URL was `facebook.com/groups/.../posts/...` — Group posts have an individual author, not a business Page, so `raw.business.identityStatus` was `"missing"` (not `"unresolved"`). Structurally, there's no identity-matching mechanism for Group posts at all in the current pipeline. **Not fixed this session** — flagged as a separate, larger structural gap requiring its own investigation (would need to decide whether/how a Group post can ever resolve business identity).

### Also confirmed NOT a bug
"Midlands Golfer" example — identity matched correctly already; `contacts.unavailable` there is because the Actor genuinely found no phone (only email/website) on that page. Correct behavior, not something to fix.

### Ruled out as the dominant cause
- Actor-level scrape failures: only 2 in 2.5 hours of Render logs, both an unrelated URL-parsing issue (`target-post-identity-unresolved` in `actor/src/cotUrls.js`).
- `maxPosts` / scan depth: production already runs `maxPosts: 10` (`cot-batch.js`), not the actor's bare default of 3; not the bottleneck.

## Fixes shipped (all three landed in `techies-validator-backend`, on top of each other on branch `fix/self-post-timestamp-inconclusive`)

All changes are in `src/cot-identity.js` (+ locking tests in `test/cot-identity.test.js`). Final test count: **149/149 passing**.

### Fix 1 — commit `50382c6` "Separate business identity from timestamp proof in self-post matching"
Added a second, narrower `matched` path in `evaluateCotIdentity()`: fires only when every existing self-match check passes (page identity matched, scrape success, self-event wording, name match) AND the timestamp read was **inconclusive** specifically (`proofRetrieval.reason` is `target-not-in-public-sample` or `bounded-public-proof-read`), never when it's an actual conflict or third-party signal. Result carries `timestampVerified: false` in that case so freshness scoring (already independent in `freshness.js`) still routes it to review, without blocking contacts.

### Fix 2 — ported `selfHandover` (commit history: `299cca3` on an unmerged branch `feature/latest-actor-data`, discovered via `vendor/PROVENANCE.json` in `techies-standalone-leads` citing it as already-merged when it wasn't)
Added `const selfHandover = /\bunder new (?:ownership|management)\b/i;` — treats a pronoun-less ownership/management handover as self-event wording.

### Fix 3 — commit `2f564e9`/`1ea2dfa` "Confirm a self-post's wording from its own paragraph, not just the model's trimmed quote" (the big one, Pattern B above)
- Added `selfPremises = /\bnew (?:premises|location)\b/i` (deliberately excludes "home" — it coincidentally matched an existing safety-test fixture's own quote).
- Widened the wording check from testing only against `quoted` (the model's trimmed evidenceQuote) to testing against `quoteContext` — **the quote's own paragraph only**, using the same paragraph-detection regex `identityProofQuote` already uses in `actor/src/contactTarget.js`, capped at 500 chars.
- **Deliberately does NOT cross into a neighboring paragraph.** First attempt used a blind ±120-char window, which broke an existing safety test (`'short-quote expansion cannot manufacture identity from unrelated or unsafe context'`) by letting a self-event phrase two paragraphs away, separated by genuinely unrelated text, get wrongly credited. Second attempt allowed exactly one adjacent paragraph, which broke a different case in the same safety test (`"We are opening a new place for Somebody Else."` sitting in the very next paragraph — no cheap way to distinguish that from a genuine continuation). Final version: **same paragraph as the quote only**.
- A known, accepted, documented gap: "Olney School of Dancing" — a bio-style post where "Beautiful New Premises with Car Park" sits several paragraphs after the quote — stays `unresolved`. This is intentional; there is no safe text-only signal to distinguish "later paragraph, same coherent post" from "later paragraph, unrelated interruption," and the safety test above requires failing closed on the latter.

### Fix 4 — commit `576aaca` "Recognize first-person-singular self-event wording alongside we/our/us"
Found via a **second-pass production audit** (see below) after Fix 3 deployed: sole traders posting under their own account write in first-person singular ("I've moved into my own unit", "I have found a new location"), never we/our/us. Extended `selfEvent` regex to add `i(?:['’]m| am|['’]ve| have)|my|me` — deliberately requires a verb suffix after bare "i" (unlike the optional suffix on "we") so a bare capital-I sentence starter can never alone trigger a match (locking test: `"I think opening a new gym..."` must NOT match).
Two related real cases found in the same audit were explicitly NOT fixed (no safe fix within this heuristic — no event keyword present at all): "launching my new business" and "back doing my hairdressing full time" — broader semantic gap, not a pronoun gap.

## Diagnostic tooling built (in `techies-standalone-leads`, Claude has push access here)

### `app/scripts/classify-stuck-contacts.mjs` (committed, on branches `claude/brave-bell-lkez5i`'s history was reset back out per user request, then re-committed on `diagnostic/classify-stuck-contacts`, then eventually the pipeline fix commits carried forward from there too)
Reads `/app/state/pipeline.sqlite` read-only, streams every lead row (mirroring the memory-safe streaming pattern `app/output.mjs` already uses — a `.all()` over the whole table previously caused an 8–12 September OOM crash loop), buckets every `contacts.status === 'unavailable'` lead into:
- `group_or_no_page_identity`
- `timestamp_inconclusive`
- `identity_matched_no_data`
- `other` (further broken down into top-15 sub-combinations of identity/business/scrape/phone/address status, with sample IDs)

**First production run (before any fix deployed), total 4,144 stuck leads:**
```
group_or_no_page_identity: 701 (16.9%)
timestamp_inconclusive: 35 (0.8%)
identity_matched_no_data: 182 (4.4%)
other: 3,226 (77.8%)
  - unresolved|business=matched|phone=verifiedButBlocked|address=none: 1,265 (39.2% of other)
  - unresolved|business=matched|phone=none|address=none: 950 (29.4%)
  - unresolved|business=matched|phone=verifiedButBlocked|address=verifiedButBlocked: 513 (15.9%)
  - third_party|business=matched|...: ~140 combined (correct behavior, not a bug)
```
The `unresolved|business=matched` combination (Pattern B above) = **~65.8% of ALL stuck leads** — confirmed as the dominant cause.

Script found on `/app/scripts/` NOT `/scripts/` at repo root — the Dockerfile only `COPY`s `app/`, `public/`, `vendor/` into the image; a top-level `scripts/` dir was silently never shipped, and `/app` itself is root-owned in the container (only `app/`'s contents get `--chown=node:node`), so both the missing-file error and a `mkdir` permission-denied error were explained by this. Fixed by moving the script under `app/scripts/`.

### One-off Render-shell scripts (not committed, pasted fresh each time due to `/tmp` not persisting across container restarts)
- `since-deploy.cjs` — counts leads validated after a given deploy timestamp, buckets by `contacts.status`.
- `since-deploy-detail.cjs` — same filter, but dumps `identityStatus`, `businessIdentityStatus`, `timestampVerified`, `reason`, and `postText` (first 200 chars) for every still-`unavailable` post-deploy lead — this is what surfaced the first-person-singular pattern (Fix 4).

**Must use `.cjs` extension** (not `.mjs`) for `require('node:sqlite')` one-liners in the Render shell — `.mjs` forces ES module mode which doesn't support `require`. Also: avoid bare `!` in double-quoted `node -e "..."` strings run directly at a bash prompt — interactive bash history expansion (`!Number.isFinite` → "event not found") silently corrupts the script; write to a file via heredoc instead.

## Post-deploy verification results so far

**Fixes 1–3 deployed:** commit `2f564e9`, live at `2026-09-15T19:44:47Z`.
- First check (~1 hr later): only 10 leads had validated since deploy — 8 unavailable, 2 partial. Too small to judge.
- Second check (~2 hrs later): 107 leads since deploy — 95 unavailable, 8 partial, 1 review_required, 3 complete (~89% still unavailable, similar to baseline). Detailed dump of all 95 `unavailable` rows revealed:
  - Several first-person-singular cases (the Fix 4 pattern) — new finding.
  - Many rows with `postText: ""` (scrape captured no caption at all — a different, scraping-level issue, not a wording-heuristic issue).
  - Many rows with `businessIdentityStatus: "missing"` (no Page identity — same class as Pattern C, or genuinely personal profiles, which is correctly-intentional `unresolved` behavior per existing code comments).
  - Several genuinely vague/ambiguous posts that arguably shouldn't auto-resolve even by human judgment (search recall bringing in noise unrelated to genuine relocation/opening/ownership events).
  - A few correctly-`third_party` and correctly-`matched` rows mixed in.

**Fix 4 deployed:** commit `576aaca`, live at `2026-09-15T21:11:40Z`. **Not yet re-checked** — a session reminder is scheduled for `2026-09-16T00:45Z` (~3.5 hrs post-deploy) to re-run the post-deploy scripts and see whether the `unresolved` rate on new leads has actually dropped now that all four fixes are live.

## Other developments during the session (unrelated to the identity fix, but touched the same repos)

- **Apify account swap** — user hit their account's usage limit twice; both times Claude updated `APIFY_API_TOKEN` (validator-backend) and `STANDALONE_APIFY_TOKEN` (standalone-leads) via Render's `update_environment_variables` tool. **Side effect learned the hard way**: Render always triggers a redeploy on any env var change, regardless of the `autoDeploy` setting — this caused one unintended deploy of a not-yet-vetted identity fix (flagged transparently to the user when it happened) and one intentional pickup of the diagnostic script.
- **Git branch hygiene incidents**: a stop-hook repeatedly flagged "unpushed commits" in `techies-validator-backend` because Claude cannot push there (read-only GitHub App access) — resolved each time by generating a patch/pasting file content for the user, then `git reset --hard origin/...` locally so no local-only commit lingers to trigger the hook.
- User asked to delete a specific commit (`a3a1ccf`, the diagnostic script) from `claude/brave-bell-lkez5i` only, keeping it on a separate `diagnostic/classify-stuck-contacts` branch — done via `git branch -f` + `git push --force-with-lease`, after explicit confirmation since this rewrites public history.
- `git am` repeatedly failed on the user's Windows/Git-Bash checkout of `techies-validator-backend` (line-ending mismatches even though `npm test` output initially appeared to show the new tests passing — turned out to be **stale cached terminal output**, not an actual successful patch; `git status` showing zero modified tracked files was the tell). Resolved by abandoning `git am` entirely and just pasting full file content / targeted line replacements for manual editing.
- Reviewed and closed out a secondary vendor-drift question (Step 3 item 2 from the original plan): the Google phone-source hyphen check difference between `techies-standalone-leads`'s vendored `cot-contacts.js` and `techies-validator-backend`'s copy was confirmed **not a bug** — real `phoneSource` values from `actor/src/googleContacts.js` (`google-official-website-tel`/`-labeled`) always carry the hyphenated suffix either way.

## Outstanding / not yet done

1. **Re-check post-Fix-4 deploy results** (scheduled reminder ~2026-09-16T00:45Z) — is the `unresolved` rate on new leads actually dropping now?
2. **Vendor the fixes into `techies-standalone-leads`** — `vendor/src/cot-identity.js` there is a separate copy; it already independently has `selfHandover` (from a different branch) but not the timestamp-inconclusive path, paragraph-window wording, or first-person pronoun fixes. Needs porting + `vendor/PROVENANCE.json` re-pinned once the validator-backend fixes are confirmed working.
3. **Investigate Pattern C (Group posts, ~17% of stuck leads)** — no identity mechanism exists for Facebook Group posts at all currently. Not started; would need its own design discussion (can Group-post identity even be resolved safely, and how).
4. **Lower-priority items from the original handoff, untouched**: error-level logging for validation halts (currently `console.log`, meaning a 20-hour outage produced no alertable signal), a longer memory-metrics window (previous crash-loop concern already resolved by other commits), tick-cost review.
5. The `postText: ""` (empty scrape) and `businessIdentityStatus: "missing"` (non-Group personal-profile) sub-patterns seen in the Fix-4-era sample haven't been root-caused — unclear how much of the remaining `unavailable` rate they represent versus genuinely non-qualifying search noise.

## Key files for continuation

- `techies-validator-backend/src/cot-identity.js` — `evaluateCotIdentity()`, `applyCotIdentityPolicy()`. All four fixes are here.
- `techies-validator-backend/src/cot-contacts.js` — `enrichCotContacts()`, the `usable` gate consumer.
- `techies-validator-backend/test/cot-identity.test.js` — 15 tests covering all fix branches and their safety boundaries.
- `techies-standalone-leads/app/scripts/classify-stuck-contacts.mjs` — bulk diagnostic tool.
- `techies-standalone-leads/vendor/src/cot-identity.js`, `vendor/PROVENANCE.json` — pending vendor sync.
- `techies-standalone-leads/app/output.mjs` — `leadDetail()`, `reviewBreakdown()`, `snapshot()` (the memory-safe streaming pattern to imitate for any future bulk queries).
