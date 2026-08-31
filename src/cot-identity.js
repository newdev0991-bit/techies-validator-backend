import { normalizeLead } from './card-data.js';
import { resolvedContactTarget } from '../actor/src/contactTarget.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const nameKey = value => text(value).normalize('NFKD').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const referral = /\b(?:good luck to|shout[ -]?out to|visit our friends|check out (?:our friends|this business)|welcome (?:them|you) to)\b/i;
const selfEvent = /\b(?:we(?:['’]re| are|['’]ve| have)?|our|us)\b[\s\S]{0,100}\b(?:open(?:ing|ed)?|mov(?:e|ed|ing)|relocat\w*|premises|management|ownership)\b/i;

// A matched publisher is not proof that the event concerns that publisher.
// Model claims may narrow supplied evidence; they cannot create identity proof.
export function evaluateCotIdentity(lead = {}, claim = {}) {
  const raw = lead.fetchResults?.rawData || lead.fetchResults?.actorData || {};
  const caption = text(raw.postText);
  const company = normalizeLead(lead).name;
  const publisher = text(raw.postAuthor || raw.pageName);
  const target = resolvedContactTarget(raw, claim);
  if (target) return { schemaVersion: 'cot-business-identity-v1', status: 'matched',
    publisherName: publisher, businessName: target.businessName, relationship: target.relationship,
    evidenceQuote: target.evidenceQuote, locationQuote: target.locationQuote, requiresManualReview: false,
    reason: 'The business named in the exact proof has independently matched contact-source evidence.' };
  const imported = Boolean(lead['Search Post ID']);
  const quoted = text(claim?.evidenceQuote);
  const businessName = text(claim?.businessName);
  const quotePresent = quoted.length >= 12 && quoted.length <= 500 && caption.includes(quoted);
  const taggedNames = [...caption.matchAll(/([A-Z][\p{L}\p{N}'’&.-]*(?:[ \t]+[A-Z][\p{L}\p{N}'’&.-]*){0,5})[ \t]*\(@[a-zA-Z0-9_.]+\)/gu)].map(m => m[1]);
  const differentTaggedBusiness = taggedNames.some(name => nameKey(name) !== nameKey(company));
  const thirdParty = referral.test(caption) || differentTaggedBusiness ||
    (quotePresent && claim?.relationship === 'third_party');
  let status = imported ? 'unresolved' : 'not_required';
  let reason = imported ? 'Search author is a candidate; the business responsible for the event is unresolved.' : '';
  if (thirdParty) {
    status = 'third_party';
    reason = 'The proof promotes another business; publisher contacts cannot be attributed to that business.';
  } else if (imported && nameKey(company) && nameKey(publisher) && quotePresent && claim?.relationship === 'self' &&
      nameKey(businessName) === nameKey(company) && nameKey(publisher) === nameKey(company) &&
      raw.business?.identityStatus === 'matched' && raw.scrape?.success === true &&
      raw.time_target_matched === true &&
      (selfEvent.test(quoted) || (nameKey(company).length >= 4 && nameKey(quoted).includes(nameKey(company))))) {
    status = 'matched';
    reason = 'The exact proof supports the candidate business as the subject of the event.';
  }
  return { schemaVersion: 'cot-business-identity-v1', status, publisherName: publisher,
    businessName: status === 'matched' ? company : businessName,
    relationship: thirdParty ? 'third_party' : status === 'matched' ? 'self' : 'unknown',
    evidenceQuote: quotePresent ? quoted : '', locationQuote: text(claim?.locationQuote),
    requiresManualReview: !['matched', 'not_required'].includes(status), reason };
}

export function applyCotIdentityPolicy(analysis, identity) {
  if (!identity.requiresManualReview) return { ...analysis, business_identity: identity };
  return { ...analysis, business_identity: identity,
    verdict: analysis.verdict === 'GOOD' ? 'UNCLEAR' : analysis.verdict,
    needs_manual_review: true,
    reasoning: `${analysis.reasoning || ''} [Business identity: ${identity.reason}]`.trim() };
}
