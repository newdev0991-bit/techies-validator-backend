import test from 'node:test';
import assert from 'node:assert/strict';
import { cotContactEvidence } from '../src/cotContacts.js';

const output = { canonicalUrl: 'https://www.facebook.com/example',
  contact: { phone: '01632960999', phoneVerified: true, phoneSource: 'submitted-lead' },
  address: { full: 'Submitted address' } };

test('COT does not present submitted contact fallbacks as scraped', () => {
  const evidence = cotContactEvidence(output, { identityStatus: 'matched' });
  assert.equal(evidence.contact.phone, null);
  assert.equal(evidence.contact.phoneVerified, false);
  assert.equal(evidence.address.full, null);
  assert.equal(evidence.address.verified, false);
});

test('COT publishes matched observed contacts with field provenance', () => {
  const evidence = cotContactEvidence(output, { identityStatus: 'matched',
    phone: '01632960123', phoneVerified: true, phoneSource: 'facebook-page-page-text',
    address: 'Observed business address' });
  assert.equal(evidence.contact.phone, '01632960123');
  assert.equal(evidence.address.full, 'Observed business address');
  assert.equal(evidence.address.verified, true);
  assert.match(evidence.address.sourceUrl, /about_contact/);
});

test('unconfirmed identity cannot publish an observed address or phone', () => {
  const evidence = cotContactEvidence(output, { identityStatus: 'unconfirmed',
    phone: '01632960123', phoneVerified: true, address: 'Unrelated address' });
  assert.equal(evidence.contact.phone, null);
  assert.equal(evidence.address.verified, false);
});
