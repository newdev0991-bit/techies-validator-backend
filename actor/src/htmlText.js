/**
 * Minimal HTML reading for pages that are fetched rather than rendered.
 *
 * This is not a parser and does not try to be one. It answers the two questions the contact
 * fallback actually asks of a page - what does it link to, and what does it say - well enough for
 * an identity match, without a DOM.
 */

const ANCHOR_OPEN_RE = /<a\b([^>]*)>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;

/**
 * A cap on link text, not on the link.
 *
 * The first version of this matched an anchor and its closing tag together with a 300-character
 * limit on what sat between them, which silently dropped every anchor bigger than that. On a
 * Google results page a result link wraps its title, snippet and sitelinks, so the links that were
 * dropped were precisely the ones worth reading - 335 KB of results yielded 23 anchors. The href
 * is now taken from the opening tag alone, and only the text is bounded.
 */
const MAX_ANCHOR_TEXT_CHARS = 2000;

export function decodeBasicEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** Anchors as `{ href, text }`, with the href resolved against the page it was found on. */
export function readHtmlAnchors(html, baseUrl) {
    const source = String(html || '');
    const anchors = [];

    for (const match of source.matchAll(ANCHOR_OPEN_RE)) {
        const hrefMatch = match[1].match(HREF_RE);
        if (!hrefMatch) continue;
        const rawHref = decodeBasicEntities(hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim();
        if (!rawHref) continue;

        let href = rawHref;
        // mailto:/tel: must survive verbatim; only navigable links are worth resolving.
        if (!/^(mailto:|tel:)/i.test(rawHref)) {
            try {
                href = new URL(rawHref, baseUrl).href;
            } catch {
                continue;
            }
        }

        const textStart = match.index + match[0].length;
        const closeIndex = source.indexOf('</a', textStart);
        const textEnd =
            closeIndex === -1
                ? Math.min(source.length, textStart + MAX_ANCHOR_TEXT_CHARS)
                : Math.min(closeIndex, textStart + MAX_ANCHOR_TEXT_CHARS);
        const text = decodeBasicEntities(source.slice(textStart, textEnd).replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();

        anchors.push({ href, text });
    }

    return anchors;
}

/**
 * Visible text, near enough for identity matching. Script and style bodies are dropped first -
 * inlined JSON otherwise contributes a business's name to pages that merely link to it.
 */
export function htmlToVisibleText(html) {
    return decodeBasicEntities(
        String(html || '')
            .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' '),
    )
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

/** The page title, for identity evidence that does not depend on body layout. */
export function readHtmlTitle(html) {
    return decodeBasicEntities(String(html || '').match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] || '').trim();
}
