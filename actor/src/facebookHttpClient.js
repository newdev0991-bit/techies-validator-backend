/**
 * HTTP transport for Facebook page reads.
 *
 * Every Facebook read this Actor makes starts with one logged-out GET of the page. That single
 * response carries everything downstream needs: the page's identity and contact evidence, and the
 * `lsd` token plus visitor cookies the timeline GraphQL call replays. Fetching it once and passing
 * the session around is the difference between two requests per lead and five.
 *
 * Facebook answers a logged-out visitor in three ways, and they need different handling:
 *   - the real page, carrying a userID
 *   - a JS shell with no payload, served at random - a different exit IP usually clears it
 *   - an error page for content it will not show logged out, which every exit IP answers the same
 * Retrying the second and not the third is why the retry policy lives here rather than in a
 * generic wrapper.
 */
import { gotScraping } from 'got-scraping';

export const FACEBOOK_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/**
 * First-visit Chrome document headers. Deliberately no cookies: a first-time visitor has none,
 * Facebook sets `datr` itself, and a hardcoded `datr` shared across exit IPs is a bot signal.
 */
export const DOCUMENT_HEADERS = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'en-GB,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    priority: 'u=0, i',
    'sec-ch-ua': '"Chromium";v="139", "Not;A=Brand";v="99", "Google Chrome";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': FACEBOOK_USER_AGENT,
};

/** What Chrome sends on a Comet GraphQL XHR - a cors/empty/same-origin fetch, not a navigation. */
export const GRAPHQL_HEADERS = {
    accept: '*/*',
    'accept-language': 'en-GB,en;q=0.9',
    'content-type': 'application/x-www-form-urlencoded',
    origin: 'https://www.facebook.com',
    priority: 'u=1, i',
    'sec-ch-ua': '"Chromium";v="139", "Not;A=Brand";v="99", "Google Chrome";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': FACEBOOK_USER_AGENT,
    'x-asbd-id': '129477',
};

const LSD_TOKEN_RE = /"LSD",\[\],\{"token":"([^"]+)"/;
const USER_ID_RE = /"userID":\s*"(\d+)"/;
const PROFILE_ID_RE = /"(?:profile_id|pageID|entity_id)":\s*"(\d{5,})"/;

/**
 * Facebook renders a full error page - site chrome, no page payload - for pages it will not show a
 * logged-out visitor: deleted, private, restricted, or a mistyped vanity URL. It carries no userID,
 * which is otherwise indistinguishable from being blocked, so these markers tell an unavailable
 * page from a transient shell and stop the retry loop spending residential traffic on a settled
 * answer.
 */
const UNAVAILABLE_MARKERS = ['CometErrorRoot', "content isn't available"];

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export function isRetryableStatus(statusCode) {
    return RETRYABLE_STATUS.has(Number(statusCode));
}

/**
 * Run `attempt` until it reports success, redrawing the proxy session each time.
 *
 * `attempt` receives the proxy URL for that try and returns `{ ok, value, reason }`. A thrown
 * error is treated as retryable - at this layer every throw is a transport failure - while a
 * returned `{ ok: false, retryable: false }` settles immediately.
 */
export async function withProxyRetries(
    attempt,
    { maxAttempts = DEFAULT_MAX_ATTEMPTS, newProxyUrl = null, label = 'request', log = () => {} } = {},
) {
    const attemptLimit = Math.max(1, Number(maxAttempts) || 1);
    let lastReason = `${label}-failed`;

    for (let attemptIndex = 0; attemptIndex < attemptLimit; attemptIndex++) {
        const proxyUrl = newProxyUrl ? await newProxyUrl(attemptIndex) : null;
        let outcome;
        try {
            outcome = await attempt(proxyUrl, attemptIndex);
        } catch (error) {
            outcome = { ok: false, retryable: true, reason: `${label}-error: ${error.message}` };
        }

        if (outcome.ok) return outcome;
        lastReason = outcome.reason || lastReason;
        if (outcome.retryable === false) return { ok: false, reason: lastReason };

        if (attemptIndex < attemptLimit - 1) {
            log(`   ${label} attempt ${attemptIndex + 1}/${attemptLimit} failed (${lastReason}); retrying on a new exit IP`);
            await sleep(RETRY_BACKOFF_MS * (attemptIndex + 1));
        }
    }

    return { ok: false, reason: lastReason };
}

/**
 * Fetch a Facebook page logged out and keep the session it establishes.
 *
 * Resolves to `{ ok: false, reason }` rather than throwing: a page that cannot be read is a row
 * outcome the caller reports, not an exception that should end the batch.
 */
export async function openFacebookPageSession(
    pageUrl,
    { newProxyUrl = null, maxAttempts = DEFAULT_MAX_ATTEMPTS, timeoutMs = 60000, log = () => {} } = {},
) {
    const result = await withProxyRetries(
        async (proxyUrl) => {
            const response = await gotScraping({
                url: pageUrl,
                headers: DOCUMENT_HEADERS,
                proxyUrl: proxyUrl || undefined,
                followRedirect: true,
                throwHttpErrors: false,
                timeout: { request: timeoutMs },
            });

            const html = String(response.body || '');
            if (isRetryableStatus(response.statusCode)) {
                return { ok: false, retryable: true, reason: `facebook-http-${response.statusCode}` };
            }

            const pageId = html.match(USER_ID_RE)?.[1] || html.match(PROFILE_ID_RE)?.[1] || '';
            if (!pageId) {
                if (UNAVAILABLE_MARKERS.some((marker) => html.includes(marker))) {
                    return { ok: false, retryable: false, reason: 'page-unavailable-logged-out' };
                }
                return { ok: false, retryable: true, reason: 'facebook-returned-shell-page' };
            }

            return {
                ok: true,
                value: {
                    html,
                    pageId,
                    pageUrl,
                    proxyUrl,
                    statusCode: response.statusCode,
                    lsd: html.match(LSD_TOKEN_RE)?.[1] || '',
                    cookieHeader: (response.headers['set-cookie'] || [])
                        .map((cookie) => cookie.split(';')[0])
                        .join('; '),
                },
            };
        },
        { maxAttempts, newProxyUrl, label: 'facebook page fetch', log },
    );

    return result.ok ? { ...result.value, failureReason: null } : { failureReason: result.reason };
}

/**
 * POST to Facebook's GraphQL endpoint on an established session, retrying transport failures.
 *
 * The session's cookies and `lsd` are bound to the exit IP that minted them, so unlike the page
 * fetch this keeps the same proxy URL across attempts rather than redrawing one.
 */
export async function postGraphql(
    session,
    form,
    { friendlyName = '', maxAttempts = DEFAULT_MAX_ATTEMPTS, timeoutMs = 60000, log = () => {} } = {},
) {
    const headers = {
        ...GRAPHQL_HEADERS,
        'x-fb-friendly-name': friendlyName,
        referer: session.pageUrl,
    };
    if (session.lsd) headers['x-fb-lsd'] = session.lsd;
    if (session.cookieHeader) headers.cookie = session.cookieHeader;

    const result = await withProxyRetries(
        async () => {
            const response = await gotScraping({
                url: 'https://www.facebook.com/api/graphql/',
                method: 'POST',
                headers,
                form: session.lsd ? { ...form, lsd: session.lsd } : form,
                proxyUrl: session.proxyUrl || undefined,
                throwHttpErrors: false,
                timeout: { request: timeoutMs },
            });
            if (isRetryableStatus(response.statusCode)) {
                return { ok: false, retryable: true, reason: `graphql-http-${response.statusCode}` };
            }
            return { ok: true, value: String(response.body || '') };
        },
        { maxAttempts, label: 'facebook graphql', log },
    );

    return result.ok ? { body: result.value, failureReason: null } : { body: '', failureReason: result.reason };
}
