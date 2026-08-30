import test from 'node:test';
import assert from 'node:assert/strict';
import { googleContactRequest, readStructuredAddresses, extractGoogleContact, readOfficialContacts, mergeGoogleContact } from '../src/googleContacts.js';

const lead = { name: 'Synthetic Example', zip: 'SW1A 1AA' };
const home = { url: 'https://syntheticexample.test/', title: 'Synthetic Example',
  text: 'Synthetic Example, London SW1A 1AA', contactUrl: 'https://syntheticexample.test/contact' };
const postal = { '@type': 'PostalAddress', streetAddress: 'Synthetic premises', addressLocality: 'London', postalCode: 'SW1A 1AA', addressCountry: 'GB' };
const structured = addresses => readStructuredAddresses(`<script type="application/ld+json">${JSON.stringify({ '@graph': addresses })}</script>`);
const siteAddress = structured([{ '@type': 'LocalBusiness', name: lead.name, address: postal }]);
const request = { phone: true, address: true, email: false };

test('COT email alone cannot suppress missing phone/address work; legacy policy remains', () => {
  const result = { email: 'synthetic@example.test', identityStatus: 'matched' };
  assert.equal(googleContactRequest(result), null);
  assert.deepEqual(googleContactRequest(result, { contactRequirements: 'phone_address' }), request);
  assert.equal(googleContactRequest(result, { contactRequirements: 'phone_address', includeGoogleFallback: false }), null);
  assert.equal(googleContactRequest({ ...result, phone: '01632960123', phoneVerified: true,
    address: 'Synthetic premises', facebookEvidenceUrl: home.url }, { contactRequirements: 'phone_address' }), null);
});

test('email-only homepage follows one contact page for COT phone and address', async () => {
  const reads = [];
  const found = await readOfficialContacts({ ...home, mailto: 'mailto:synthetic@example.test' }, lead, request, {
    readCandidate: async url => { reads.push(url); return { url, title: 'Contact',
      text: 'Call us for details', tel: 'tel:+44 1632 960123', structuredAddresses: siteAddress }; }
  });
  assert.deepEqual(reads, [home.contactUrl]);
  assert.equal(found.phone, '+44 1632 960123');
  assert.equal(found.address, 'Synthetic premises, London, SW1A 1AA, GB');
  assert.equal(found.phoneSourceUrl, home.contactUrl);
  assert.equal(found.addressSourceUrl, home.contactUrl);
});

test('homepage phone does not suppress address lookup and retains its original URL', async () => {
  let reads = 0;
  const found = await readOfficialContacts({ ...home, tel: 'tel:01632960123' }, lead, request, {
    readCandidate: async url => { reads++; return { url, text: 'Contact', structuredAddresses: siteAddress }; }
  });
  assert.equal(reads, 1);
  assert.equal(found.phoneSourceUrl, home.url);
  assert.equal(found.addressSourceUrl, home.contactUrl);
  const complete = { ...home, tel: 'tel:01632960123', structuredAddresses: siteAddress };
  await readOfficialContacts(complete, lead, request, { readCandidate: async () => { assert.fail('complete home needs no follow-up'); } });
});

test('address ownership, postcode, completeness and branch ambiguity are enforced', () => {
  for (const entries of [
    [{ name: 'Another Business', address: postal }],
    [{ name: lead.name, address: { ...postal, streetAddress: '' } }],
    [{ name: lead.name, address: { ...postal, postalCode: 'M12 6FA' } }],
    [{ name: lead.name, address: { ...postal, addressCountry: 'US' } }],
    [{ name: lead.name, address: [postal, { ...postal, streetAddress: 'Second synthetic premises' }] }],
  ]) {
    assert.equal(extractGoogleContact({ ...home, structuredAddresses: structured(entries) }, lead, request), null);
  }
  assert.deepEqual(readStructuredAddresses('<script type="application/ld+json">bad json</script>'), []);
});

test('off-site redirects cannot borrow identity; follow-up failure keeps earlier phone', async () => {
  const candidate = { ...home, tel: 'tel:01632960123' };
  for (const readCandidate of [
    async () => ({ url: 'https://unrelated.test/contact', text: 'Synthetic Example SW1A 1AA', structuredAddresses: siteAddress }),
    async () => { throw new Error('bounded timeout'); },
  ]) {
    const found = await readOfficialContacts(candidate, lead, request, { readCandidate });
    assert.equal(found.phone, '01632960123');
    assert.equal(found.address, '');
  }
  assert.equal(await readOfficialContacts(home, lead, request, { canRead: () => false,
    readCandidate: async () => assert.fail('time budget exceeded') }), null);
});

test('identity context may be shared across pages, contact values may not', async () => {
  const found = await readOfficialContacts({ ...home, text: `${home.text} 01632960123`, zip: '' },
    { ...lead, zip: 'M12 6FA' }, request, {
      readCandidate: async url => ({ url, text: 'M12 6FA', structuredAddresses: [] })
    });
  assert.equal(found, null); // The home phone never passed the lead-location check.
});

test('adding a Google address preserves a verified Facebook phone and its source', () => {
  const result = { phone: '01632960123', phoneVerified: true, phoneSource: 'facebook-page-page-text' };
  mergeGoogleContact(result, { phone: '01632960999', phoneVerified: true, phoneSource: 'google-official-website-tel',
    address: siteAddress[0].full, addressVerified: true, addressSourceUrl: home.contactUrl });
  assert.equal(result.phone, '01632960123');
  assert.equal(result.phoneSource, 'facebook-page-page-text');
  assert.equal(result.addressSourceUrl, home.contactUrl);
});
