import { normalizeLead } from './card-data.js';
import { resolvedContactTarget, proofQuote, sameVerifiedBusiness, identityProofQuote, looseNameKey } from '../actor/src/contactTarget.js';

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
  const originalQuote = proofQuote(caption, text(claim?.evidenceQuote));
  const quoted = identityProofQuote(raw, claim);
  const businessName = text(claim?.businessName);
  const quotePresent = quoted.length >= 12 && quoted.length <= 500 && caption.includes(quoted);
  const taggedNames = [...caption.matchAll(/([A-Z][\p{L}\p{N}'’&.-]*(?:[ \t]+[A-Z][\p{L}\p{N}'’&.-]*){0,5})[ \t]*\(@[a-zA-Z0-9_.]+\)/gu)].map(m => m[1]);
  const differentTaggedBusiness = taggedNames.some(name => nameKey(name) !== nameKey(company));
  const thirdParty = referral.test(caption) || differentTaggedBusiness ||
    (quotePresent && claim?.relationship === 'third_party');
  let status = imported ? 'unresolved' : 'not_required';
  let reason = imported ? 'Search author is a candidate; the business responsible for the event is unresolved.' : '';
  let timestampVerified = null;
  // 2026-09-14: a Facebook page name routinely drops the "Ltd"/"Limited"/"Plc" a
  // companies-house name carries -- that typographical difference alone was
  // failing this match (both here and on the businessName check) and pushing a
  // genuine self-post to 'unresolved', identical in outcome to an actually
  // unrelated personal profile. looseNameKey compares with that suffix ignored;
  // it does not loosen anything else this branch already requires (the literal
  // quote, the self-event wording, the independent page-identity/scrape checks
  // below all still apply unchanged).
  const selfMatchCore = imported && nameKey(company) && nameKey(publisher) && quotePresent && claim?.relationship === 'self' &&
      (looseNameKey(businessName) === looseNameKey(company) || sameVerifiedBusiness(raw, businessName)) && looseNameKey(publisher) === looseNameKey(company) &&
      raw.business?.identityStatus === 'matched' && raw.scrape?.success === true &&
      (selfEvent.test(quoted) || (nameKey(company).length >= 4 && nameKey(quoted).includes(nameKey(company))));
  // 2026-09-15: business identity ("is this the right business?") and timestamp proof
  // ("did we independently verify exactly when this post went up?") are separate
  // questions. Facebook's logged-out response for the exact submitted post sometimes
  // has no dated story node to read at all (proofRetrieval reason
  // target-not-in-public-sample / bounded-public-proof-read) -- that is inconclusive
  // evidence, not evidence of a wrong business or a fabricated event, and it was
  // silently blocking every contact this session traced (CJTrims: page matched, self-
  // event wording matched, only the timestamp read came back empty). A genuinely
  // contradictory signal (a date conflict, a third-party referral) must still fail
  // this branch -- `thirdParty` above already takes priority, and a conflicting date
  // is a different proofRetrieval reason, so it is not in this set.
  const timestampInconclusive = raw.time_target_matched !== true &&
    ['target-not-in-public-sample', 'bounded-public-proof-read'].includes(text(raw.proofRetrieval?.reason));
  if (thirdParty) {
    status = 'third_party';
    reason = 'The proof promotes another business; publisher contacts cannot be attributed to that business.';
  } else if (selfMatchCore && raw.time_target_matched === true) {
    status = 'matched';
    timestampVerified = true;
    reason = 'The exact proof supports the candidate business as the subject of the event.';
  } else if (selfMatchCore && timestampInconclusive) {
    status = 'matched';
    timestampVerified = false;
    reason = 'The candidate business is independently matched; the exact post timestamp could not be read from the public sample, so freshness is reviewed separately.';
  }
  return { schemaVersion: 'cot-business-identity-v1', status, publisherName: publisher,
    businessName: status === 'matched' ? company : businessName,
    relationship: thirdParty ? 'third_party' : status === 'matched' ? 'self' : 'unknown',
    evidenceQuote: quotePresent ? quoted : '', locationQuote: text(claim?.locationQuote),
    ...(quotePresent && quoted !== originalQuote ? { evidenceSelection: {
      method: 'adjacent-proof-context', originalQuote, selectedQuote: quoted } } : {}),
    ...(status === 'matched' ? { timestampVerified } : {}),
    requiresManualReview: !['matched', 'not_required'].includes(status), reason };
}

export function applyCotIdentityPolicy(analysis, identity) {
  if (!identity.requiresManualReview) return { ...analysis, business_identity: identity };
  // A proof that promotes a *different* business (third_party) cannot have its
  // publisher's contacts attributed to that business, so a GOOD verdict there is
  // downgraded to UNCLEAR. An unresolved own-business identity is different: it is
  // typically a personal profile the pipeline could not tie to a business Page, and
  // per the personal-profile rules that is not, on its own, a reason to doubt the
  // opportunity. Keep the verdict and route it to review with the gap named — the
  // pipeline's `requiresManualReview` still stops it reaching READY unattended, and
  // enrichCotContacts still withholds the publisher's phone from an unresolved lead.
  const unattributable = identity.relationship === 'third_party';
  return { ...analysis, business_identity: identity,
    verdict: unattributable && analysis.verdict === 'GOOD' ? 'UNCLEAR' : analysis.verdict,
    needs_manual_review: true,
    reasoning: `${analysis.reasoning || ''} [Business identity: ${identity.reason}]`.trim() };
}
