/**
 * Google SERP fetching, matched to the approach the Google Search Scraper Actor already uses.
 *
 * Three things in here are the difference between a SERP that returns and one that times out:
 *
 * 1. The user agent. An ancient mobile UA makes Google serve its small static results page instead
 *    of the JavaScript-heavy desktop one - fewer bytes over a proxy hop, and result links that are
 *    plain anchors rather than script-driven.
 * 2. The consent cookie. Without it a European exit IP gets the consent interstitial, which parses
 *    as a page with no results rather than as an error.
 * 3. The timeout. GOOGLE_SERP returns 300-500 KB through the proxy; the measured budget for that
 *    is tens of seconds, not the few seconds an ordinary request gets. A tight cap here does not
 *    fail fast, it fails always.
 */
import { gotScraping } from 'got-scraping';

/**
 * Deliberately not a modern desktop UA. See the note above: this one selects Google's lightweight
 * results page, which is both smaller and easier to parse.
 */
export const GOOGLE_SERP_USER_AGENT =
    'HTC_Touch_3G Mozilla/4.0 (compatible; MSIE 6.0; Windows CE; IEMobile 7.11)';

/** `CONSENT`/`SOCS` pre-answer the EU consent gate that otherwise replaces the results page. */
export const GOOGLE_SERP_HEADERS = {
    'user-agent': GOOGLE_SERP_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.5',
    dnt: '1',
    connection: 'keep-alive',
    'upgrade-insecure-requests': '1',
    cookie: 'CONSENT=PENDING+988; SOCS=CAESHAgBEhIaAB',
};

const DEFAULT_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/** Exponential backoff with jitter, so retries from concurrent rows do not land together. */
export function backoffDelayMs(attempt, baseDelayMs = DEFAULT_RETRY_DELAY_MS) {
    return baseDelayMs * 2 ** attempt + Math.random() * 1000;
}

export function buildGoogleSearchUrl(query, { lang = 'en', region = 'uk', numResults = 10, start = 0, safe = 'active' } = {}) {
    const params = new URLSearchParams({
        q: query,
        num: String(Math.min(numResults + 2, 100)),
        hl: lang,
        start: String(start),
        safe,
        ...(region ? { gl: region } : {}),
    });
    return `http://www.google.com/search?${params.toString()}`;
}

/**
 * Fetch one SERP, retrying transport failures and rate limits within the caller's time budget.
 *
 * Returns `{ html, failureReason }` rather than throwing: a search that cannot be run is a missing
 * enrichment, not a failed row.
 */
export async function fetchGoogleSerp(
    query,
    {
        proxyUrl = null,
        remainingMs = DEFAULT_TIMEOUT_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        log = () => {},
    } = {},
) {
    const url = buildGoogleSearchUrl(query);
    const deadlineAt = Date.now() + Math.max(0, remainingMs);
    let lastReason = 'google-serp-failed';

    for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
        const budgetLeft = deadlineAt - Date.now();
        if (budgetLeft < MIN_TIMEOUT_MS) {
            return { html: '', failureReason: lastReason === 'google-serp-failed' ? 'google-serp-budget-exhausted' : lastReason };
        }

        try {
            const response = await gotScraping({
                url,
                headers: GOOGLE_SERP_HEADERS,
                proxyUrl: proxyUrl || undefined,
                followRedirect: true,
                throwHttpErrors: false,
                decompress: true,
                timeout: { request: Math.min(timeoutMs, budgetLeft - 250) },
            });

            if (response.statusCode === 200) return { html: String(response.body || ''), failureReason: null };
            lastReason = `google-serp-http-${response.statusCode}`;
            if (response.statusCode === 429) log('   Google rate limited; backing off before retry');
        } catch (error) {
            lastReason = `google-serp-error: ${error.message}`;
        }

        if (attempt < maxAttempts - 1) {
            const delay = backoffDelayMs(attempt, retryDelayMs);
            if (deadlineAt - Date.now() < delay + MIN_TIMEOUT_MS) break;
            log(`   Google SERP attempt ${attempt + 1}/${maxAttempts} failed (${lastReason}); retrying in ${Math.round(delay)}ms`);
            await sleep(delay);
        }
    }

    return { html: '', failureReason: lastReason };
}
