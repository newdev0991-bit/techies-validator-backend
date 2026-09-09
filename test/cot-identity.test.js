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
