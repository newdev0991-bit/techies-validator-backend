import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCotContacts, cotLeadWithContacts, normalizeUkContactPhone } from '../src/cot-contacts.js';

const url = 'https://www.facebook.com/example/posts/12345';
function fixture() {
  return { 'Company Name': 'Example business', 'Lead Proof URL': url, fetchResults: { rawData: {
    inputUrl: url, status: 'success', scrape: { success: true },
    business: { identityStatus: 'matched' },
    contact: { identityStatus: 'matched', phone: '+44 1632 960123', phoneVerified: true,
      phoneSource: 'facebook-page-page-text', sourceUrl: 'https://www.facebook.com/example/about' },
    address: { full: 'Example premises, London SW1A 1AA', verified: true,
      source: 'facebook-page-contact', sourceUrl: 'https://www.facebook.com/example/about' }
  } } };
}

test('verified contacts fill missing analysis fields without modifying source data', () => {
  const lead = fixture();
  const enrichment = enrichCotContacts(lead);
  assert.equal(enrichment.status, 'complete');
  assert.equal(enrichment.phone.value, '01632960123');
  assert.equal(enrichment.postcode.value, 'SW1A 1AA');
  const enriched = cotLeadWithContacts(lead, enrichment);
  assert.equal(enriched['Phone Number'], '01632960123');
  assert.equal(enriched['Address 1'], 'Example premises, London SW1A 1AA');
  assert.equal(lead['Phone Number'], undefined);
});

test('wrong row, failed scrape, blocked page and wrong business cannot supply contacts', () => {
  for (const mutate of [
    raw => { raw.inputUrl = url.replace('12345', '98765'); },
    raw => { raw.scrape.success = false; },
    raw => { raw.scrape.blocked = true; },
    raw => { raw.business.wrongBusiness = true; },
    raw => { raw.contact.identityStatus = 'unconfirmed'; raw.business.identityStatus = 'unconfirmed'; }
  ]) {
    const lead = fixture(); mutate(lead.fetchResults.rawData);
    assert.equal(enrichCotContacts(lead).status, 'unavailable');
  }
});

test('legacy addresses, submitted echoes and unverified phone fallbacks are withheld', () => {
  const lead = fixture();
  const raw = lead.fetchResults.rawData;
  delete raw.address.verified;
  raw.contact.phoneSource = 'submitted-lead';
  raw.phone = '01632960999'; raw.ocrText = 'Phone 01632960999';
  const enrichment = enrichCotContacts(lead);
  assert.equal(enrichment.phone.value, '');
  assert.equal(enrichment.address.value, '');
  raw.contact.phoneSource = 'facebook-page-contact';
  raw.contact.phoneVerified = false;
  assert.equal(enrichCotContacts(lead).phone.value, '');
});

test('conflicting input is preserved and equivalent phone formatting is accepted', () => {
  const lead = fixture(); lead['Phone Number'] = '01632 960999';
  const enrichment = enrichCotContacts(lead);
  assert.equal(enrichment.status, 'review_required');
  assert.equal(cotLeadWithContacts(lead, enrichment)['Phone Number'], '01632 960999');
  lead['Phone Number'] = '01632 960123';
  assert.equal(enrichCotContacts(lead).phone.conflict, false);
});

test('invalid phones and unsafe source URLs remain blank', () => {
  for (const value of ['123', 'phone 01632960123', '001632960123', '016329601234567']) {
    assert.equal(normalizeUkContactPhone(value), '');
  }
  const lead = fixture(); lead.fetchResults.rawData.contact.sourceUrl = 'javascript:alert(1)';
  assert.equal(enrichCotContacts(lead).phone.value, '');
});
