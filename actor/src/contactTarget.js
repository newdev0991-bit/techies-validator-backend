// Shared by the Actor and validator. Model output can select literal proof evidence,
// but cannot invent a business, location, URL, or a relationship to the publisher.
export const contactNameKey = value => String(value || '').normalize('NFKD').toLowerCase()
    .replace(/['’](?=[a-z])/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const selfEvent = /\b(?:we|our|us)\b[\s\S]{0,160}\b(?:open\w*|mov\w*|relocat\w*|premises|management|ownership)\b/i;
const event = /\b(?:open\w*|mov\w*|relocat\w*|premises|management|ownership|coming soon)\b/i;

// Match typography, not paraphrases. Return the original contiguous evidence span.
export function proofQuote(caption, quote) {
    if (typeof caption !== 'string' || typeof quote !== 'string' || !quote.trim()) return '';
    const fold = value => value.normalize('NFKC').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-').replace(/\s+/g, ' ').toLowerCase();
    let normalized = '', positions = [];
    for (let i = 0; i < caption.length; i++) {
        for (const char of fold(caption[i])) {
            if (char === ' ' && normalized.endsWith(' ')) continue;
            normalized += char; positions.push(i);
        }
    }
    const needle = fold(quote.trim());
    const start = normalized.indexOf(needle);
    if (start < 0) return '';
    return caption.slice(positions[start], positions[start + needle.length - 1] + 1);
}

export function sameVerifiedBusiness(raw, name) {
    const key = value => contactNameKey(value).replace(/\s+(?:ltd|limited|plc)$/, '').trim();
    return raw?.business?.identityStatus === 'matched' && raw?.scrape?.success === true
        && raw.time_target_matched === true && !raw.business.wrongBusiness
        && key(name).length >= 4 && key(raw.postAuthor || raw.pageName) === key(name);
}

// Expand only an already literal self-claim into its immediate proof context.
// Do not search disconnected paragraphs or replace a missing/invented model quote.
export function identityProofQuote(raw, claim = {}) {
    const caption = typeof raw?.postText === 'string' ? raw.postText : '';
    const quote = proofQuote(caption, claim?.evidenceQuote);
    if (quote.length < 12 || quote.length > 500 || event.test(quote) ||
        claim?.relationship !== 'self' || !sameVerifiedBusiness(raw, claim.businessName) ||
        raw.scrape.blocked || raw.scrape.loginRequired || raw.scrape.notFound) return quote;
    const paragraphs = [...caption.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)];
    const start = caption.indexOf(quote);
    const index = paragraphs.findIndex(p => p.index <= start && p.index + p[0].length >= start + quote.length);
    if (index < 0) return quote;
    for (const end of [index, index + 1]) {
        const next = paragraphs[end];
        if (!next) continue;
        const context = caption.slice(paragraphs[index].index, next.index + next[0].length);
        const named = (` ${contactNameKey(context)} `).includes(` ${contactNameKey(claim.businessName)} `);
        if (context.length <= 500 && named && selfEvent.test(context)) return context;
    }
    return quote;
}

export function contactTargetFromProof(raw, claim = {}) {
    if (!claim || typeof claim !== 'object') return null;
    const caption = typeof raw?.postText === 'string' ? raw.postText : '';
    const name = String(claim.businessName || '').trim();
    const quote = identityProofQuote(raw, claim);
    const requestedLocation = String(claim.locationQuote || '').trim();
    const location = requestedLocation ? proofQuote(caption, requestedLocation) : '';
    if (raw?.scrape?.success !== true || raw.time_target_matched !== true ||
        raw.scrape.blocked || raw.scrape.loginRequired || raw.scrape.notFound ||
        !name || name.length > 200 || quote.length < 12 || quote.length > 500 || !caption.includes(quote) ||
        (requestedLocation && (!location || location.length > 160)) || !event.test(quote)) return null;
    const publisherMatches = contactNameKey(raw.postAuthor || raw.pageName) === contactNameKey(name) || sameVerifiedBusiness(raw, name);
    const referral = /\b(?:good luck to|shout[ -]?out to|visit our friends|check out (?:our friends|this business))\b/i.test(caption);
    const differentTaggedBusiness = [...caption.matchAll(/([A-Z][\p{L}\p{N}'’&.-]*(?:[ \t]+[A-Z][\p{L}\p{N}'’&.-]*){0,5})[ \t]*\(@[a-zA-Z0-9_.]+\)/gu)]
        .some(match => contactNameKey(match[1]) !== contactNameKey(name));
    const named = (` ${contactNameKey(quote)} `).includes(` ${contactNameKey(name)} `);
    const self = claim.relationship === 'self' && publisherMatches && !referral && !differentTaggedBusiness && (named || selfEvent.test(quote));
    const thirdParty = claim.relationship === 'third_party' && named && !publisherMatches;
    if (!self && !thirdParty) return null;
    return { schemaVersion: 'cot-contact-target-v1', businessName: name, evidenceQuote: quote,
        locationQuote: location, relationship: self ? 'self' : 'third_party', proofUrl: raw.inputUrl };
}

export function resolvedContactTarget(raw, claim) {
    const expected = contactTargetFromProof(raw, claim);
    const actual = raw?.contactTarget;
    if (!expected || actual?.verified !== true || actual.schemaVersion !== expected.schemaVersion ||
        actual.proofUrl !== raw.inputUrl || actual.businessName !== expected.businessName ||
        actual.evidenceQuote !== expected.evidenceQuote || actual.relationship !== expected.relationship ||
        actual.locationQuote !== expected.locationQuote) return null;
    return actual;
}
