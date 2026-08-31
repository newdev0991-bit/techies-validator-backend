import { contactTargetFromProof, contactNameKey } from './contactTarget.js';
import { readFacebookContacts } from './facebookContacts.js';
import { extractPageEvidence, extractAddress, extractPhone } from './facebookPageEvidence.js';
import { googleBusinessIdentityMatches, readOfficialContacts, mergeGoogleContact } from './googleContacts.js';
import { normalizeUkContactPhone } from './contactValues.js';

export async function scrapeCotTargetContacts(result, request, scopedInput, { proofOutput, readPage, lookup, readSite, log = () => {} }) {
  const target = contactTargetFromProof(proofOutput, request.contactTarget);
  result.contactLookup = { status: 'unresolved', required: ['phone', 'address'], attempts: [] };
  if (!target) return;
  result.contactTarget = { ...target, verified: false };
  if (!normalizeUkContactPhone(result.phone)) { result.phone = ''; result.phoneVerified = false; }
  const location = target.locationQuote;
  const subjectLead = { name: target.businessName, address: location,
    zip: location.match(/\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i)?.[0] || '',
    requireLocation: target.relationship === 'third_party', country: 'United Kingdom' };
  const author = request.searchAuthor;
  // Reuse discovery, not its verification claim. Never use the publisher's site
  // for a third-party event or treat a search-supplied site as a page-linked site.
  if (target.relationship === 'self' && author &&
      contactNameKey(author.name) === contactNameKey(target.businessName) &&
      String(author.id || '') && String(author.id) === String(result.pageId || '') &&
      typeof author.website === 'string' && author.website.length <= 2000) {
    subjectLead.contactCandidateWebsite = author.website;
  }
  if (target.relationship === 'third_party') {
    // All publisher contact values and site links are discarded before discovery.
    for (const field of ['phone', 'address', 'email', 'website']) {
      result[field] = '';
      for (const suffix of ['Verified', 'Source', 'SourceUrl', 'IdentityStatus']) result[field + suffix] = null;
    }
    result.contactIdentityStatus = 'unconfirmed';
  } else if (contactNameKey(result.pageName) === contactNameKey(target.businessName)) {
    const lines = String(proofOutput.postText || '').split('\n');
    if (!result.address) {
      const address = extractAddress(lines);
      if (address) Object.assign(result, { address, addressVerified: true, addressIdentityStatus: 'matched',
        addressSource: 'facebook-post-contact', addressSourceUrl: result.inputUrl });
    }
    if (!result.phone) {
      const phone = extractPhone(lines);
      if (normalizeUkContactPhone(phone)) Object.assign(result, { phone, phoneVerified: true, phoneIdentityStatus: 'matched',
        phoneSource: 'facebook-proof-contact', phoneSourceUrl: result.inputUrl });
    }
    const attempts = await readFacebookContacts(result, {
      pageName: result.pageName, pageId: result.pageId, sourceUrl: result.facebookEvidenceUrl,
    }, target.businessName, { readPage, log });
    result.contactLookup.attempts.push(...attempts);
    result.contactTarget.verified = result.identityStatus === 'matched';
  }
  await lookup(result, { ...scopedInput, lead: subjectLead }, log, {
    readFacebookCandidate: target.relationship !== 'third_party' ? undefined : async (url, deadline) => {
      try {
        const page = await readPage(url, deadline);
        if (page.failureReason) return null;
        const evidence = extractPageEvidence(page.html);
        if (contactNameKey(evidence.pageName) !== contactNameKey(target.businessName)) return null;
        const contacts = {};
        const attempts = await readFacebookContacts(contacts, { ...evidence, pageId: page.pageId, sourceUrl: url }, target.businessName,
          { readPage: value => readPage(value, deadline), log });
        const identity = googleBusinessIdentityMatches([evidence.pageName, evidence.about, evidence.locationHint, contacts.address].join('\n'), url, subjectLead);
        // Search rank/name alone never joins a publisher to a promoted business.
        if (!identity.locationMatched) return null;
        Object.assign(contacts, { contactIdentityStatus: 'matched', contactSource: 'facebook-page-contact', contactSourceUrl: url });
        result.contactLookup.attempts.push({ url, status: 'identity_matched' }, ...attempts);
        if ((!contacts.phone || !contacts.address) && contacts.website && deadline - Date.now() >= 1000) {
          const official = /^https?:\/\//i.test(contacts.website) ? contacts.website : `https://${contacts.website}`;
          try {
            const candidate = await readSite(official, deadline);
            const extra = await readOfficialContacts(candidate, { ...subjectLead, officialWebsite: official },
              { phone: !contacts.phone, address: !contacts.address, email: false }, {
                readCandidate: value => readSite(value, deadline), canRead: () => deadline - Date.now() >= 1000 });
            if (extra) mergeGoogleContact(contacts, extra);
          } catch { /* Retain already-observed Facebook contacts. */ }
        }
        return contacts;
      } catch { return null; }
    },
  });
  result.contactTarget.verified ||= result.contactIdentityStatus === 'matched';
  result.contactLookup.status = result.phone && result.address && result.contactTarget.verified ? 'complete' :
    result.phone || result.address ? 'partial' : 'unavailable';
  result.contactLookup.businessName = target.businessName;
  result.contactLookup.warning = result.googleContactWarning || null;
}

