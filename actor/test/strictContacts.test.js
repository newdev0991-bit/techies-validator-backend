import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapeCotTargetContacts } from '../src/cotContactScraper.js';
import { cotContactEvidence } from '../src/cotContacts.js';
import { contactTargetFromProof } from '../src/contactTarget.js';
import { facebookContactPages, facebookContactRoot } from '../src/facebookContacts.js';
import { extractPhone, extractAddress } from '../src/facebookPageEvidence.js';
import { extractGoogleContact, googleBusinessIdentityMatches, readLabeledAddresses, mergeGoogleContact, readOfficialContacts } from '../src/googleContacts.js';
import { publicAddress, assertPublicContactUrl } from '../src/publicContactUrl.js';
import { normalizeUkContactPhone } from '../src/contactValues.js';

const proofUrl = 'https://www.facebook.com/syntheticpublisher/posts/12345';
const name = 'Synthetic Makers';
const caption = 'Synthetic Makers is opening soon in Taunton.';
const claim = { businessName: name, relationship: 'third_party', evidenceQuote: caption, locationQuote: 'Taunton' };
const proof = { inputUrl: proofUrl, postText: caption, pageName: 'Synthetic Publisher', scrape: { success: true }, time_target_matched: true };
const html = (title, ...runs) => `<meta property="og:title" content="${title}">${runs.map(text => JSON.stringify({ text })).join('')}`;
const noRead = async () => assert.fail('unexpected request');

test('promoted-business contact phase discards publisher contacts and reads the matched target About page', async () => {
  const result = { pageName: 'Synthetic Publisher', identityStatus: 'matched', inputUrl: proofUrl,
    facebookEvidenceUrl: 'https://www.facebook.com/syntheticpublisher',
    phone: '01632960999', phoneVerified: true, address: 'Publisher address', website: 'publisher.test' };
  const urls = [];
  await scrapeCotTargetContacts(result, { contactTarget: claim }, { contactRequirements: 'phone_address' }, {
    proofOutput: proof,
    readPage: async url => { urls.push(url); return { pageId: '2468', html: url.includes('about_contact')
      ? html(name, '01632960123', '12 Synthetic Road, Taunton, TA1 1AA')
      : html(`${name} | Taunton`, '12 Synthetic Road, Taunton, TA1 1AA') }; },
    readSite: noRead,
    lookup: async (current, input, _log, options) => {
      assert.equal(current.phone, ''); assert.equal(current.address, ''); assert.equal(current.website, '');
      assert.equal(input.lead.name, name); assert.equal(input.lead.requireLocation, true);
      const contact = await options.readFacebookCandidate('https://www.facebook.com/syntheticmakers', Date.now() + 10000);
      mergeGoogleContact(current, contact);
    },
  });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /about_contact_and_basic_info/);
  assert.equal(result.phone, '01632960123');
  assert.equal(result.address, '12 Synthetic Road, Taunton, TA1 1AA');
  assert.equal(result.contactTarget.verified, true);
  const output = cotContactEvidence({}, result);
  assert.equal(output.contact.sourceUrl, urls[1]);
  assert.equal(output.address.sourceUrl, urls[0]);
  assert.equal(output.contactLookup.status, 'complete');
});

test('publisher name match without target location cannot supply a promoted-business contact', async () => {
  const result = { identityStatus: 'matched', inputUrl: proofUrl };
  await scrapeCotTargetContacts(result, { contactTarget: claim }, {}, {
    proofOutput: proof, readSite: noRead,
    readPage: async () => ({ pageId: '2468', html: html(name, '01632960123', '12 Synthetic Road, London, SW1A 1AA') }),
    lookup: async (_current, _input, _log, options) => {
      assert.equal(await options.readFacebookCandidate('https://www.facebook.com/syntheticmakers', Date.now() + 10000), null);
    },
  });
  assert.equal(result.contactTarget.verified, false);
});

test('exact first-party proof address is extracted without borrowing publisher or submitted fields', async () => {
  const selfCaption = 'We are opening our new shop!\nFiley Avenue Royston Barnsley S714PZ';
  const self = { ...proof, postText: selfCaption, pageName: name };
  const result = { pageName: name, inputUrl: proofUrl, identityStatus: 'matched', phone: '01632960123', phoneVerified: true,
    phoneSource: 'facebook-page-page-text', facebookEvidenceUrl: 'https://www.facebook.com/syntheticmakers' };
  await scrapeCotTargetContacts(result, { contactTarget: { businessName: name, relationship: 'self', evidenceQuote: 'We are opening our new shop!' } }, {}, {
    proofOutput: self, readPage: noRead, readSite: noRead, lookup: async () => {},
  });
  assert.equal(result.address, 'Filey Avenue Royston Barnsley S714PZ');
  assert.equal(result.addressSourceUrl, proofUrl);
  assert.equal(result.addressSource, 'facebook-post-contact');
});

test('missing/invented target evidence and self claims on referral posts fail closed', () => {
  for (const invalid of [null, {}, { ...claim, businessName: 'Different Makers' },
    { ...claim, evidenceQuote: 'Synthetic Makers opening yesterday in London.' }, { ...claim, locationQuote: 'London' }]) {
    assert.equal(contactTargetFromProof(proof, invalid), null);
  }
  assert.equal(contactTargetFromProof({ ...proof, time_target_matched: false }, claim), null);
  const referred = { ...proof, pageName: name, postText: 'We are opening our guide. Good luck to Ed and Mollie with the refit!' };
  assert.equal(contactTargetFromProof(referred, { businessName: name, relationship: 'self', evidenceQuote: referred.postText }), null);
});

test('plain UK phone lines work; IDs and ambiguous street addresses remain blank', () => {
  assert.equal(normalizeUkContactPhone('+44 (0)1632 960123'), '01632960123');
  assert.equal(extractPhone(['01632960123']), '01632960123');
  assert.equal(extractPhone(['123456789012345']), '');
  assert.equal(extractAddress(['TA1 1AA']), '');
  assert.equal(extractAddress(['12 Synthetic Road, Taunton, TA1 1AA', '16 Synthetic Road, London, SW1A 1AA']), '');
  assert.deepEqual(facebookContactPages('https://www.facebook.com/profile.php?id=123'), ['https://www.facebook.com/profile.php?id=123&sk=about_contact_and_basic_info']);
});

test('linked official .com with a one-word business name can supply its actual contact block', async () => {
  assert.equal(googleBusinessIdentityMatches("Mollie's Makers Taunton", 'https://molliesmakers.test', { name: "Mollie’s Makers", address: 'Taunton' }).matched, true);
  assert.equal(googleBusinessIdentityMatches('Synthetic Makers Taunton TA1 1AA', 'https://syntheticmakers.test', { name, address: 'Taunton', zip: 'SW1A 1AA' }).matched, false);
  const lead = { name: 'Synthetic', officialWebsite: 'https://synthetic.test/' };
  const found = await readOfficialContacts({ url: lead.officialWebsite, title: 'Synthetic', text: 'Synthetic', contactUrl: 'https://synthetic.test/contact' }, lead,
    { phone: true, address: true, email: false }, { readCandidate: async url => ({ url, title: 'Contact Synthetic', text: 'Synthetic',
      tel: 'tel:01632960123', labeledAddresses: readLabeledAddresses('<address>12 Synthetic Road, Taunton TA1 1AA</address>', '') }) });
  assert.equal(found.address, '12 Synthetic Road, Taunton TA1 1AA');
  assert.equal(found.addressSource, 'google-official-website-address');
  assert.equal(found.phone, '01632960123');
  assert.equal(googleBusinessIdentityMatches('Synthetic Makers', 'https://syntheticmakers.test', { name, requireLocation: true }).matched, false);
});

test('official address extraction rejects legal-office and ambiguous branch addresses', () => {
  assert.deepEqual(readLabeledAddresses('<address>Registered office 12 Synthetic Road, Taunton TA1 1AA</address>', ''), []);
  const contact = extractGoogleContact({ url: 'https://syntheticmakers.test', title: name, text: name,
    labeledAddresses: ['12 Synthetic Road, Taunton TA1 1AA', '16 Synthetic Road, London SW1A 1AA'] }, { name }, { address: true, phone: false, email: false });
  assert.equal(contact, null);
});

test('contact HTTP rejects internal destinations and private DNS results', () => {
  assert.equal(facebookContactRoot('https://www.facebook.com/l.php?u=http://127.0.0.1/'), null);
  assert.equal(facebookContactRoot('https://www.facebook.com/login'), null);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(publicAddress(address), false);
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://localhost/', 'http://172.16.1.1/', 'https://user:pass@public.test/', 'file:///private', 'https://public.test:8080/']) assert.throws(() => assertPublicContactUrl(url));
  assert.equal(publicAddress('8.8.8.8'), true);
});
