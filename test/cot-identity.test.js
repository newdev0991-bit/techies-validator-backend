import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCotIdentity, applyCotIdentityPolicy } from '../src/cot-identity.js';
import { enrichCotContacts } from '../src/cot-contacts.js';
import { contactTargetFromProof, identityProofQuote } from '../actor/src/contactTarget.js';

const caption = 'We are opening our new premises in London.';
const proof = 'https://www.facebook.com/synthetic/posts/123';
const lead = { 'Company Name': 'Synthetic Example', 'Search Post ID': '123', 'Lead Proof URL': proof,
  fetchResults: { rawData: { inputUrl: proof, status: 'success', postText: caption, postAuthor: 'Synthetic Example',
    scrape: { success: true }, business: { identityStatus: 'matched' }, time_target_matched: true,
    contact: { phone: '01632960123', phoneVerified: true, identityStatus: 'matched', phoneSource: 'facebook-page-page-text', sourceUrl: 'https://www.facebook.com/synthetic' },
    address: { full: 'Synthetic premises London SW1A 1AA', verified: true, source: 'facebook-page-contact', sourceUrl: 'https://www.facebook.com/synthetic' }
  } } };
const claim = { relationship: 'self', businessName: 'Synthetic Example', evidenceQuote: caption };

test('exact self-event quote and matched publisher pass identity without changing lead fields', () => {
  const snapshot = JSON.stringify(lead);
  const identity = evaluateCotIdentity(lead, claim);
  assert.equal(identity.status, 'matched');
  assert.equal(enrichCotContacts(lead, identity).status, 'complete');
  assert.equal(JSON.stringify(lead), snapshot);
});

// 2026-09-14: a Facebook page routinely drops the "Ltd"/"Limited"/"Plc" a business's
// full company name carries -- e.g. the page is "Synthetic Example" but the lead's
// Company Name (from the client's own records) is "Synthetic Example Ltd". That
// typographical difference alone was pushing a genuine self-post to 'unresolved',
// indistinguishable in outcome from an actually unrelated personal profile with a
// coincidentally similar name. This must still fail closed on a REAL mismatch
// (different business entirely), only pass on the suffix difference.
test('a legal-suffix difference (Ltd/Limited/Plc) does not block a genuine self-match', () => {
  const suffixed = { ...lead, 'Company Name': 'Synthetic Example Ltd' };
  const identity = evaluateCotIdentity(suffixed, claim);
  assert.equal(identity.status, 'matched');
  assert.equal(enrichCotContacts(suffixed, identity).status, 'complete');
});

test('missing, invented, wrong-business or unrelated evidence fails closed for search authors', () => {
  for (const invalid of [null, {}, { ...claim, evidenceQuote: 'We are opening tomorrow at noon.' },
    { ...claim, businessName: 'Another Business' }, { ...claim, relationship: 'unknown' }]) {
    const identity = evaluateCotIdentity(lead, invalid);
    assert.equal(identity.status, 'unresolved');
    const analysis = applyCotIdentityPolicy({ verdict: 'GOOD' }, identity);
    // Failing closed here means routing to review and withholding the publisher's
    // contacts -- not downgrading the verdict. An unresolved own-business identity
    // (typically a personal profile) keeps its verdict; only third_party downgrades.
    assert.equal(analysis.verdict, 'GOOD');
    assert.equal(analysis.needs_manual_review, true);
    assert.equal(enrichCotContacts(lead, identity).phone.value, '');
  }
  const unmatched = structuredClone(lead);
  unmatched.fetchResults.rawData.time_target_matched = false;
  assert.equal(evaluateCotIdentity(unmatched, claim).status, 'unresolved');
});

test('an unresolved personal-profile lead keeps its verdict; only third_party is downgraded', () => {
  const unresolved = evaluateCotIdentity(lead, { ...claim, relationship: 'unknown' });
  assert.equal(unresolved.relationship, 'unknown');
  const keptGood = applyCotIdentityPolicy({ verdict: 'GOOD' }, unresolved);
  assert.equal(keptGood.verdict, 'GOOD');
  assert.equal(keptGood.needs_manual_review, true);
  assert.match(keptGood.reasoning, /Business identity:/);

  const promoter = structuredClone(lead);
  promoter.fetchResults.rawData.postText = 'Good luck to Ed and Mollie with the new shop!';
  const thirdParty = evaluateCotIdentity(promoter, { ...claim, evidenceQuote: promoter.fetchResults.rawData.postText });
  assert.equal(thirdParty.relationship, 'third_party');
  assert.equal(applyCotIdentityPolicy({ verdict: 'GOOD' }, thirdParty).verdict, 'UNCLEAR');
});

test('referrals and another tagged business override model self claims and publisher contacts', () => {
  for (const text of ['We are opening our guide. Good luck to Ed and Mollie with the refit!',
    'Bunzilla (@bunzilla_mcr) have opened a second location.']) {
    const publisher = structuredClone(lead);
    publisher.fetchResults.rawData.postText = text;
    const identity = evaluateCotIdentity(publisher, { ...claim, evidenceQuote: text });
    assert.equal(identity.status, 'third_party');
    assert.equal(enrichCotContacts(publisher, identity).status, 'unavailable');
    assert.equal(applyCotIdentityPolicy({ verdict: 'GOOD' }, identity).verdict, 'UNCLEAR');
    assert.equal(applyCotIdentityPolicy({ verdict: 'BAD' }, identity).verdict, 'BAD');
  }
});

// 2026-09-15: business identity and timestamp proof are separate questions. A page can
// be independently confirmed as the right business, with a genuine self-event quote,
// while Facebook's logged-out response for the exact submitted post simply has no dated
// story node to read (target-not-in-public-sample / bounded-public-proof-read). That is
// inconclusive, not contradictory -- it must not block contacts the way a wrong business
// or a real conflicting date does.
test('an unverifiable-but-not-contradicted timestamp still allows a matched self-post', () => {
  const row = structuredClone(lead);
  row.fetchResults.rawData.time_target_matched = false;
  row.fetchResults.rawData.proofRetrieval = { status: 'unverified', reason: 'target-not-in-public-sample' };
  const identity = evaluateCotIdentity(row, claim);
  assert.equal(identity.status, 'matched');
  assert.equal(identity.timestampVerified, false);
  assert.equal(identity.requiresManualReview, false);
  assert.equal(enrichCotContacts(row, identity).status, 'complete');

  const bounded = structuredClone(row);
  bounded.fetchResults.rawData.proofRetrieval.reason = 'bounded-public-proof-read';
  assert.equal(evaluateCotIdentity(bounded, claim).status, 'matched');
});

test('a genuinely conflicting or unresolved timestamp still fails closed', () => {
  const conflicted = structuredClone(lead);
  conflicted.fetchResults.rawData.time_target_matched = false;
  conflicted.fetchResults.rawData.proofRetrieval = { status: 'unverified', reason: 'target-date-conflict' };
  assert.equal(evaluateCotIdentity(conflicted, claim).status, 'unresolved');

  // No proofRetrieval reason at all (older/unknown failure shapes) must not be treated
  // as inconclusive by default -- only the two named reasons above qualify.
  const bare = structuredClone(lead);
  bare.fetchResults.rawData.time_target_matched = false;
  assert.equal(evaluateCotIdentity(bare, claim).status, 'unresolved');

  // The third-party path must still win outright regardless of timestamp reason.
  const thirdParty = structuredClone(lead);
  thirdParty.fetchResults.rawData.postText = 'Good luck to Ed and Mollie with the new shop!';
  thirdParty.fetchResults.rawData.time_target_matched = false;
  thirdParty.fetchResults.rawData.proofRetrieval = { status: 'unverified', reason: 'target-not-in-public-sample' };
  const identity = evaluateCotIdentity(thirdParty, { ...claim, evidenceQuote: thirdParty.fetchResults.rawData.postText });
  assert.equal(identity.status, 'third_party');
});

// 2026-09-16: the model's evidenceQuote is often a trimmed paraphrase that drops the
// pronoun next to it in the actual caption -- the single largest bucket in the
// contact-yield audit (~66% of all contacts.unavailable leads) was a matched Page,
// matched publisher, 'self' model claim, that still fell to 'unresolved' because the
// self-event wording check only looked at that trimmed quote.
test('an ownership or management change is a self-event even without a pronoun', () => {
  for (const text of ['Belmont House is under new ownership.', 'Croft House, under new management from Monday.']) {
    const post = structuredClone(lead);
    post.fetchResults.rawData.postText = text;
    const identity = evaluateCotIdentity(post, { ...claim, evidenceQuote: text });
    assert.equal(identity.status, 'matched', `expected matched for ${JSON.stringify(text)}`);
  }
});

test('a pronoun-less event still fails when the model does not claim it as its own', () => {
  const text = 'The Old Mill is under new ownership.';
  const post = structuredClone(lead);
  post.fetchResults.rawData.postText = text;
  for (const invalid of [{ ...claim, relationship: 'third_party', evidenceQuote: text },
    { ...claim, businessName: 'The Old Mill', evidenceQuote: text }]) {
    assert.notEqual(evaluateCotIdentity(post, invalid).status, 'matched');
  }
});

test('a real self-post: a pronoun adjacent to a trimmed model quote still counts (Apex Injury Clinic shape)', () => {
  const post = structuredClone(lead);
  post.fetchResults.rawData.postText = "It's amazing to see how much we've grown since opening. And what better way to celebrate than a move to new premises! We're excited to share that Apex has moved to Jungle Gym Salhouse!";
  post.fetchResults.rawData.postAuthor = 'Apex Injury Clinic';
  const withLead = { ...post, 'Company Name': 'Apex Injury Clinic' };
  const identity = evaluateCotIdentity(withLead, { relationship: 'self', businessName: 'Apex Injury Clinic',
    evidenceQuote: 'Apex has moved to Jungle Gym Salhouse' });
  assert.equal(identity.status, 'matched');
  assert.equal(enrichCotContacts(withLead, identity).status, 'complete');
});

// Real production row, NOT fixed by this change -- documented rather than silently
// dropped. "Beautiful New Premises with Car Park" sits two paragraphs after the quoted
// text ("Principal: Lynette House" and a class list come between), so the paragraph-
// bounded context (mirroring identityProofQuote's own index-1/index/index+1 adjacency)
// correctly does not reach it -- the same bound that keeps
// 'short-quote expansion cannot manufacture identity from unrelated or unsafe context'
// passing. A wider reach that did catch this shape reached equally far into genuinely
// unrelated content in that other test; there is no text-only signal here to tell "later
// paragraph, same coherent post" apart from "later paragraph, unrelated interruption".
// Left unresolved (routes to manual review) rather than risk the unrelated-content case.
test('a pronoun-less bio-style announcement several paragraphs from the quote stays unresolved (Olney School of Dancing shape)', () => {
  const post = structuredClone(lead);
  post.fetchResults.rawData.postText = "Olney's Longest-Established Dance School\n\nPrincipal: Lynette House\n\nBeautiful New Premises with Car Park\nat Olney Community Centre";
  post.fetchResults.rawData.postAuthor = 'Olney School of Dancing';
  const withLead = { ...post, 'Company Name': 'Olney School of Dancing' };
  const identity = evaluateCotIdentity(withLead, { relationship: 'self', businessName: 'Olney School of Dancing',
    evidenceQuote: "Olney's Longest-Established Dance School" });
  assert.equal(identity.status, 'unresolved');
});

test('the widened wording window still fails closed on a third-party post naming a distant, unrelated pronoun', () => {
  const post = structuredClone(lead);
  post.fetchResults.rawData.postText = 'We had a great night out! Good luck to Ed and Mollie with the new shop!';
  const identity = evaluateCotIdentity(post, { ...claim, evidenceQuote: 'Good luck to Ed and Mollie with the new shop!' });
  assert.equal(identity.status, 'third_party');
});

test('an existing explicit lead retains compatibility when no referral evidence exists', () => {
  const existing = structuredClone(lead); delete existing['Search Post ID'];
  assert.equal(evaluateCotIdentity(existing).status, 'not_required');
});

test('literal short self-claim can use adjacent named event context without mutating the model claim', () => {
  const row = structuredClone(lead);
  row.fetchResults.rawData.postText = "We've got a new home!\n\nWe're turning our new premises into the first permanent home of Synthetic Example.";
  const short = { ...claim, evidenceQuote: "We've got a new home!" };
  const before = JSON.stringify({ row, short });
  const identity = evaluateCotIdentity(row, short);
  assert.equal(identity.status, 'matched');
  assert.equal(identity.evidenceQuote, row.fetchResults.rawData.postText);
  assert.equal(identity.evidenceSelection.originalQuote, short.evidenceQuote);
  assert.equal(contactTargetFromProof(row.fetchResults.rawData, short).evidenceQuote, identity.evidenceQuote);
  assert.equal(enrichCotContacts(row, identity).status, 'complete');
  assert.equal(JSON.stringify({ row, short }), before);
});

test('short-quote expansion cannot manufacture identity from unrelated or unsafe context', () => {
  const short = { ...claim, evidenceQuote: "We've got a new home!" };
  const opening = "We're turning our new premises into the first permanent home of Synthetic Example.";
  const base = structuredClone(lead);
  base.fetchResults.rawData.postText = `${short.evidenceQuote}\n\n${opening}`;
  for (const change of [
    r => { r.fetchResults.rawData.business.identityStatus = 'unknown'; },
    r => { r.fetchResults.rawData.business.wrongBusiness = true; },
    r => { r.fetchResults.rawData.time_target_matched = false; },
    r => { r.fetchResults.rawData.scrape.success = false; },
    r => { r.fetchResults.rawData.scrape.blocked = true; },
    r => { r.fetchResults.rawData.scrape.loginRequired = true; },
    r => { r.fetchResults.rawData.scrape.notFound = true; },
    r => { r.fetchResults.rawData.postAuthor = 'Different Publisher'; },
    r => { r.fetchResults.rawData.postText = `${short.evidenceQuote}\n\nUnrelated intervening paragraph.\n\n${opening}`; },
    r => { r.fetchResults.rawData.postText = `${short.evidenceQuote}\n\n${'padding '.repeat(75)}${opening}`; },
    r => { r.fetchResults.rawData.postText = `${short.evidenceQuote}\n\nWe are opening a new place for Somebody Else.`; },
  ]) {
    const row = structuredClone(base); change(row);
    assert.equal(evaluateCotIdentity(row, short).status, 'unresolved');
  }
  assert.equal(identityProofQuote(base.fetchResults.rawData, { ...short, evidenceQuote: 'Invented opening announcement.' }), '');
  assert.equal(identityProofQuote(base.fetchResults.rawData, { ...short, relationship: 'third_party' }), short.evidenceQuote);
  for (const suffix of ['Good luck to our friends!', 'Other Makers (@other_makers) are opening soon.']) {
    const row = structuredClone(base); row.fetchResults.rawData.postText += `\n\n${suffix}`;
    assert.equal(evaluateCotIdentity(row, short).status, 'third_party');
    assert.equal(contactTargetFromProof(row.fetchResults.rawData, short), null);
  }
});
