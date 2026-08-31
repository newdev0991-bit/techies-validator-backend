// Shared by the Actor and validator. Model output can select literal proof evidence,
// but cannot invent a business, location, URL, or a relationship to the publisher.
export const contactNameKey = value => String(value || '').normalize('NFKD').toLowerCase()
    .replace(/['’](?=[a-z])/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const selfEvent = /\b(?:we|our|us)\b[\s\S]{0,160}\b(?:open\w*|mov\w*|relocat\w*|premises|management|ownership)\b/i;
const event = /\b(?:open\w*|mov\w*|relocat\w*|premises|management|ownership|coming soon)\b/i;

export function contactTargetFromProof(raw, claim = {}) {
    if (!claim || typeof claim !== 'object') return null;
    const caption = typeof raw?.postText === 'string' ? raw.postText : '';
    const name = String(claim.businessName || '').trim();
    const quote = String(claim.evidenceQuote || '').trim();
    const location = String(claim.locationQuote || '').trim();
    if (raw?.scrape?.success !== true || raw.time_target_matched !== true ||
        raw.scrape.blocked || raw.scrape.loginRequired || raw.scrape.notFound ||
        !name || name.length > 200 || quote.length < 12 || quote.length > 500 || !caption.includes(quote) ||
        (location && (location.length > 160 || !caption.includes(location))) || !event.test(quote)) return null;
    const publisherMatches = contactNameKey(raw.postAuthor || raw.pageName) === contactNameKey(name);
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
