import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCotIdentity, applyCotIdentityPolicy } from '../src/cot-identity.js';
import { enrichCotContacts } from '../src/cot-contacts.js';

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
    assert.equal(analysis.verdict, 'UNCLEAR');
    assert.equal(analysis.needs_manual_review, true);
    assert.equal(enrichCotContacts(lead, identity).phone.value, '');
  }
  const unmatched = structuredClone(lead);
  unmatched.fetchResults.rawData.time_target_matched = false;
  assert.equal(evaluateCotIdentity(unmatched, claim).status, 'unresolved');
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
