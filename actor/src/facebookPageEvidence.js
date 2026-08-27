/**
 * Identity and contact evidence read from a logged-out Facebook page response.
 *
 * The browser path read these from the rendered DOM, which meant navigating an About tab and, when
 * that came back blank, screenshotting the page and running OCR over it. OCR is where a plausible
 * but wrong value comes from - it turned one address into "themosshoss25@gmail.com" - and a wrong
 * contact is worse than a blank one.
 *
 * The same values are in the HTML Facebook serves a logged-out visitor, exactly, as long as its
 * `\uXXXX` escapes are decoded first: that is the only reason a naive search of the raw body finds
 * no email, since Facebook escapes the `@`.
 */

/** Facebook's own domains appear in page chrome on every page and never belong to the lead. */
const PLATFORM_DOMAIN_RE = /@(?:facebook|fb|meta|messenger|instagram|whatsapp)\.[a-z.]+$/i;
const PLATFORM_SITE_RE =
    /^(?:www\.)?(?:facebook|fb|meta|messenger|instagram|whatsapp|threads|apple|google|youtube|tiktok|twitter|x)\.[a-z.]+$/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * International and UK national numbers as businesses actually write them. Deliberately not a
 * generic digit run: page markup is full of long numeric IDs, and a wrong phone number reads as
 * real to whoever calls it.
 */
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(0\)|0)?[\d][\d\s().-]{8,17}\d/g;

const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/i;
const STREET_RE = /\b(?:street|road|lane|avenue|drive|close|way|place|court|square|parade|terrace|st|rd|ave)\b/i;

const OG_TITLE_RE = /<meta property="og:title" content="([^"]*)"/;
const OG_DESCRIPTION_RE = /<meta property="og:description" content="([^"]*)"/;
const CATEGORY_RE = /"category_name":\s*"([^"]{2,60})"/;
const PERMANENTLY_CLOSED_RE = /"is_permanently_closed":\s*(true|false)/;
const TEXT_RUN_RE = /"text":"((?:[^"\\]|\\.){2,300})"/g;

/** Facebook escapes non-ASCII and several ASCII characters, `@` among them, as `\uXXXX`. */
export function decodeFacebookEscapes(value) {
    return String(value || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
        String.fromCharCode(parseInt(code, 16)),
    );
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

/**
 * The visible strings Facebook ships in its page payload. Contact details live here as ordinary
 * text runs rather than in named fields, which is why this is the surface worth reading.
 */
export function readTextRuns(html) {
    const runs = [];
    const seen = new Set();
    for (const match of String(html || '').matchAll(TEXT_RUN_RE)) {
        let run;
        try {
            run = JSON.parse(`"${match[1]}"`);
        } catch {
            run = decodeFacebookEscapes(match[1]);
        }
        run = run.trim();
        if (!run || seen.has(run)) continue;
        seen.add(run);
        runs.push(run);
    }
    return runs;
}

function normalizePhone(candidate) {
    const trimmed = String(candidate || '').trim();
    const digits = trimmed.replace(/[^\d]/g, '');
    // Shorter than a national subscriber number, or longer than E.164 allows, is an ID not a phone.
    if (digits.length < 9 || digits.length > 15) return '';
    // Prices, dates and follower counts survive the digit test; a real number is written with
    // separators or an international prefix.
    if (!/[+\s().-]/.test(trimmed)) return '';
    return trimmed.replace(/\s+/g, ' ');
}

export function extractEmail(textRuns) {
    for (const run of textRuns) {
        for (const candidate of run.match(EMAIL_RE) || []) {
            if (!PLATFORM_DOMAIN_RE.test(candidate)) return candidate.toLowerCase();
        }
    }
    return '';
}

export function extractPhone(textRuns) {
    for (const run of textRuns) {
        // A run that is mostly prose is a caption that happens to contain digits, not a phone line.
        if (run.length > 60) continue;
        for (const candidate of run.match(PHONE_RE) || []) {
            const phone = normalizePhone(candidate);
            if (phone) return phone;
        }
    }
    return '';
}

export function extractWebsite(textRuns) {
    for (const run of textRuns) {
        if (run.length > 100 || /\s/.test(run)) continue;
        const withoutScheme = run.replace(/^https?:\/\//i, '').replace(/\/$/, '');
        if (!/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(withoutScheme)) continue;
        if (PLATFORM_SITE_RE.test(withoutScheme)) continue;
        if (!/\.[a-z]{2,}$/i.test(withoutScheme)) continue;
        return withoutScheme;
    }
    return '';
}

export function extractAddress(textRuns) {
    for (const run of textRuns) {
        if (run.length < 8 || run.length > 120) continue;
        if (UK_POSTCODE_RE.test(run) || (STREET_RE.test(run) && /\d/.test(run) && run.includes(','))) {
            return run;
        }
    }
    return '';
}

/**
 * `og:title` is "Business Name | Location" on a page and just the name on a profile. The location
 * half is Facebook's own formatting, not part of the business name, so an identity match against
 * the lead has to compare the name alone.
 */
export function extractPageName(html) {
    const raw = decodeHtmlEntities(html.match(OG_TITLE_RE)?.[1] || '');
    if (!raw) return '';
    return raw
        .split('|')[0]
        .replace(/\s*[-–]\s*Facebook\s*$/i, '')
        .trim();
}

const CHAIN_SIGNAL_PATTERNS = [
    [/\bfranchis(?:e|ing|ee|es)\b/i, 'Explicit franchise wording'],
    [/\b(?:nationwide|national chain|international chain|stores nationwide)\b/i, 'Explicit national or multi-location wording'],
    [/\b(?:our locations|find a location|store locator|all locations)\b/i, 'Multiple-location wording'],
];

const CLOSED_RE = /\b(?:permanently closed|ceased trading|no longer trading|business closed|closed down)\b/i;
const TEMPORARILY_CLOSED_RE = /\btemporarily closed\b/i;

export function extractChainSignals(text) {
    return CHAIN_SIGNAL_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

export function extractTradingStatus(text, permanentlyClosed) {
    if (permanentlyClosed || CLOSED_RE.test(text)) return 'closed';
    if (TEMPORARILY_CLOSED_RE.test(text)) return 'temporarily_closed';
    return 'unknown';
}

/**
 * Everything a logged-out Facebook page response says about the business.
 *
 * Returns empty strings rather than nulls for missing values so callers can treat "not published"
 * and "not found" the same way - both mean there is no evidence to report.
 */
export function extractPageEvidence(html) {
    const decoded = decodeFacebookEscapes(html);
    const textRuns = readTextRuns(decoded);
    const about = decodeHtmlEntities(decoded.match(OG_DESCRIPTION_RE)?.[1] || '');
    const permanentlyClosed = decoded.match(PERMANENTLY_CLOSED_RE)?.[1] === 'true';
    // Chain and trading wording appears in the page's own copy, so it is read from the visible
    // runs rather than the whole payload, where script identifiers would trigger false matches.
    const visibleText = [about, ...textRuns].join('\n');

    return {
        pageName: extractPageName(decoded),
        category: decodeHtmlEntities(decoded.match(CATEGORY_RE)?.[1] || ''),
        about,
        email: extractEmail(textRuns),
        phone: extractPhone(textRuns),
        website: extractWebsite(textRuns),
        address: extractAddress(textRuns),
        permanentlyClosed,
        chainSignals: extractChainSignals(visibleText),
        tradingStatus: extractTradingStatus(visibleText, permanentlyClosed),
    };
}
