import { normalizeLead } from './card-data.js';
import { resolvedContactTarget, proofQuote, sameVerifiedBusiness, identityProofQuote, looseNameKey } from '../actor/src/contactTarget.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const nameKey = value => text(value).normalize('NFKD').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const referral = /\b(?:good luck to|shout[ -]?out to|visit our friends|check out (?:our friends|this business)|welcome (?:them|you) to)\b/i;
// 2026-09-16: a sole trader posting under their own name writes in the first-person
// singular ("I've moved into my own unit", "I'm opening..."), never we/our/us. Found
// in the same contact-yield audit as selfHandover/selfPremises: several genuine
// self-posts sit in accounts with no business partner to make "we" natural. 'i' alone
// (no apostrophe-s/space-am/etc.) is deliberately excluded from the pronoun group --
// too common a capitalized word-start to gate on without the following verb forms.
const selfEvent = /\b(?:we(?:['’]re| are|['’]ve| have)?|our|us|i(?:['’]m| am|['’]ve| have)|my|me)\b[\s\S]{0,100}\b(?:open(?:ing|ed)?|mov(?:e|ed|ing)|relocat\w*|premises|management|ownership)\b/i;
// An ownership or management handover is inherently about the business it names, and is
// written without a pronoun far more often than not. The surrounding checks still decide
// whose business it is: the model must claim the event as its own and name this business,
// and the publisher must match. This only stops a pronoun being load-bearing on its own.
const selfHandover = /\bunder new (?:ownership|management)\b/i;
// 2026-09-16: business bios routinely announce a move or a new location in pure third
// person -- "Beautiful New Premises with Car Park", "Now at our new home" written as a
// listing, never "we/our/us". Same reasoning as selfHandover: the surrounding checks
// (name match, publisher match, page identity, model's own self claim) already decide
// whose business this is; this only removes the pronoun as the sole way to say so.
// 'home' deliberately excluded: 'new home' is generic enough that it appears in
// otherwise-pronoun-dependent phrasing (see the 'short-quote expansion...' safety
// test), so it isn't reliable pronoun-less evidence on its own the way 'premises' and
// 'location' are.
const selfPremises = /\bnew (?:premises|location)\b/i;

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
  // 2026-09-16: the model's evidenceQuote is often a paraphrase that trims the exact
  // pronoun out -- e.g. it quotes "Apex has moved to Jungle Gym Salhouse" from a caption
  // that actually reads "...a move to new premises! We're excited to share that Apex has
  // moved...". Testing the wording patterns against `quoted` alone was failing genuine
  // self-posts at scale (the single largest bucket in the 2026-09-16 contact-yield audit:
  // identity stuck 'unresolved' despite a matched Page, matched publisher and a 'self'
  // model claim, on ~66% of all contacts.unavailable leads).
  // The context must stay bounded to the quote's own paragraph plus one paragraph either
  // side -- the same adjacency `identityProofQuote` (actor/src/contactTarget.js) already
  // uses for short-quote expansion -- not an arbitrary character count. A wider blind
  // window (tried first, reverted) let a self-event phrase two paragraphs away, separated
  // by genuinely unrelated text, get credited to a quote it has nothing to do with; the
  // 'short-quote expansion cannot manufacture identity from unrelated or unsafe context'
  // test exists precisely to catch that. thirdParty above already scans the *entire*
  // caption independently and takes priority, so this bounded widening still cannot let a
  // real third-party post through.
  // Crossing into a *different* paragraph than the quote turned out unsafe even one
  // paragraph over: "We are opening a new place for Somebody Else." sitting right after
  // the quote's own paragraph would otherwise read as self-event wording for a business
  // it explicitly isn't about, and there is no cheap, reliable way to tell that apart
  // from a genuine continuation like Apex's. Staying inside the quote's own paragraph
  // still fixes the dominant real pattern (a trimmed quote with its pronoun a few words
  // away in the *same* paragraph/sentence, e.g. Apex Injury Clinic: "...a move to new
  // premises! We're excited to share that Apex has moved...") without ever reasoning
  // about content outside what the model actually quoted from.
  const paragraphs = quotePresent ? [...caption.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)] : [];
  const quoteStart = quotePresent ? caption.indexOf(quoted) : -1;
  const ownParagraph = paragraphs.find(p => p.index <= quoteStart && p.index + p[0].length >= quoteStart + quoted.length);
  const quoteContext = ownParagraph && ownParagraph[0].length <= 500 ? ownParagraph[0] : quoted;
  const selfMatchCore = imported && nameKey(company) && nameKey(publisher) && quotePresent && claim?.relationship === 'self' &&
      (looseNameKey(businessName) === looseNameKey(company) || sameVerifiedBusiness(raw, businessName)) && looseNameKey(publisher) === looseNameKey(company) &&
      raw.business?.identityStatus === 'matched' && raw.scrape?.success === true &&
      (selfEvent.test(quoteContext) || selfHandover.test(quoteContext) || selfPremises.test(quoteContext) ||
        (nameKey(company).length >= 4 && nameKey(quoted).includes(nameKey(company))));
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