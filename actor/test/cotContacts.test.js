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
    facebookEvidenceUrl: 'https://www.facebook.com/profile.php?id=123',
    phone: '01632960123', phoneVerified: true, phoneSource: 'facebook-page-page-text',
    address: 'Observed business address' });
  assert.equal(evidence.contact.phone, '01632960123');
  assert.equal(evidence.address.full, 'Observed business address');
  assert.equal(evidence.address.verified, true);
  assert.equal(evidence.address.sourceUrl, 'https://www.facebook.com/profile.php?id=123');
  assert.equal(evidence.contact.sourceUrl, evidence.address.sourceUrl);
});

test('COT does not manufacture a contact source from a canonical page URL', () => {
  const evidence = cotContactEvidence(output, { identityStatus: 'matched',
    phone: '01632960123', phoneVerified: true, phoneSource: 'facebook-page-page-text', address: 'Observed address' });
  assert.equal(evidence.contact.phoneVerified, false);
  assert.equal(evidence.address.verified, false);
});

test('mixed Facebook phone and official-site address keep separate provenance', () => {
  const evidence = cotContactEvidence(output, { identityStatus: 'matched',
    phone: '01632960123', phoneVerified: true, phoneSource: 'facebook-page-page-text',
    facebookEvidenceUrl: 'https://www.facebook.com/example',
    contactSource: 'google-official-website', contactSourceUrl: 'https://synthetic.example/contact', contactIdentityStatus: 'matched',
    address: 'Synthetic premises, London, SW1A 1AA', addressVerified: true,
    addressSource: 'google-official-website-structured', addressSourceUrl: 'https://synthetic.example/contact', addressIdentityStatus: 'matched' });
  assert.equal(evidence.contact.sourceUrl, 'https://www.facebook.com/example');
  assert.equal(evidence.address.sourceUrl, 'https://synthetic.example/contact');
  assert.equal(evidence.address.source, 'google-official-website-structured');
});

test('unconfirmed identity cannot publish an observed address or phone', () => {
  const evidence = cotContactEvidence(output, { identityStatus: 'unconfirmed',
    phone: '01632960123', phoneVerified: true, address: 'Unrelated address' });
  assert.equal(evidence.contact.phone, null);
  assert.equal(evidence.address.verified, false);
});
