import { normalizeLead } from './card-data.js';
import { googleContactSourceKind } from './contact-sources.js';
import { isSuccessfulFacebookScrape, validateFacebookUrl } from './validation.js';
import { normalizeUkContactPhone, extractUkCaptionPhones } from '../actor/src/contactValues.js';
import { searchContactsFromLead } from './search-author-contacts.js';
import { proofAddresses, addressesAgree } from '../actor/src/proofAddress.js';
export { normalizeUkContactPhone } from '../actor/src/contactValues.js';

const text = value => typeof value === 'string' ? value.trim() : '';

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : '';
  } catch { return ''; }
}

function facebookOwner(value) {
  if (!validateFacebookUrl(value).ok) return '';
  const url = new URL(value);
  return url.searchParams.get('id') || url.pathname.split('/').filter(Boolean)[0] || '';
}

function field(value, submitted, source, url, normalize = v => text(v).toLowerCase().replace(/\s+/g, ' ')) {
  const conflict = Boolean(value && submitted && normalize(value) !== normalize(submitted));
  return { value, verified: Boolean(value), source: value ? source : '',
    sourceUrl: value ? url : '', submittedValue: submitted, conflict };
}

// Values come only from the Actor's identity-checked evidence, never model text,
// OCR guesses, or submitted fields echoed back as if they had been scraped.
export function enrichCotContacts(lead = {}, businessIdentity) {
  const submitted = normalizeLead(lead);
  const searchAuthor = searchContactsFromLead(lead);
  // Publisher input is retained in searchAuthor, but must not conflict with the
  // independently verified contacts of a different business named in the post.
  if (searchAuthor && businessIdentity?.relationship === 'third_party') {
    submitted.phone = ''; submitted.address = ''; submitted.zip = '';
  }
  const raw = lead.fetchResults?.rawData || lead.fetchResults?.actorData || lead.fetchResults || {};
  const proof = validateFacebookUrl(submitted.link);
  const input = validateFacebookUrl(raw.inputUrl);
  const sameRow = proof.ok && input.ok && proof.value === input.value;
  const contact = raw.contact || {};
  const address = raw.address || {};
  const usable = sameRow && isSuccessfulFacebookScrape(raw)
    && !raw.scrape?.blocked && !raw.scrape?.loginRequired && !raw.scrape?.notFound
    && !raw.business?.wrongBusiness && !businessIdentity?.requiresManualReview;
  const isPublisherContact = url => businessIdentity?.relationship === 'third_party' &&
    facebookOwner(url) && facebookOwner(url) === facebookOwner(raw.facebookEvidenceUrl || submitted.link);
  const phoneUrl = sourceUrl(contact.sourceUrl);
  const phoneSource = text(contact.phoneSource);
  const phoneAllowed = usable && contact.identityStatus === 'matched'
    && contact.phoneVerified === true && phoneUrl && !isPublisherContact(phoneUrl)
    && (/^facebook-/.test(phoneSource) ? validateFacebookUrl(phoneUrl).ok
      // Any accepted Google source, and the phone must have been read from that same source.
      : Boolean(googleContactSourceKind(contact.source)) && phoneSource.startsWith(contact.source));
  const phone = field(phoneAllowed ? normalizeUkContactPhone(contact.phone) : '',
    submitted.phone, phoneSource, phoneUrl, normalizeUkContactPhone);

  // A number observed in the exact caption remains a candidate when identity is
  // unresolved. Promote only a single number on a matched self-business proof.
  const captionObserved = sameRow && isSuccessfulFacebookScrape(raw)
    && raw.time_target_matched === true && !raw.scrape?.blocked
    && !raw.scrape?.loginRequired && !raw.scrape?.notFound && !raw.business?.wrongBusiness;
  const captionPhones = captionObserved ? extractUkCaptionPhones(raw.postText) : [];
  const ownProof = usable && businessIdentity?.status === 'matched'
    && businessIdentity.relationship === 'self';
  phone.candidates = captionPhones.map(value => ({ value, source: 'facebook-post-contact',
    sourceUrl: input.value, verified: ownProof }));
  if (ownProof && captionPhones.length) {
    phone.conflict ||= captionPhones.length > 1 || Boolean(phone.value && !captionPhones.includes(phone.value));
    if (!phone.value && captionPhones.length === 1 && !phone.conflict) {
      Object.assign(phone, field(captionPhones[0], submitted.phone, 'facebook-post-contact', input.value, normalizeUkContactPhone));
    }
  }

  // A contact the Actor found for an OWN-business proof we could not tie to a Page.
  // `usable` is false here, so nothing above can promote it -- and it must not, because
  // the identity is unproven. But discarding it outright is what left the review queue
  // full of rows reading "no verified UK business phone was found" with nothing for a
  // reviewer to act on. It is carried as an explicitly unverified candidate with its
  // source URL so a human can confirm it. `status`, `requiresManualReview` and
  // `reviewReasons` below are computed from `.value` alone and are deliberately untouched
  // by candidates, so an unproven identity still cannot reach READY. third_party is
  // excluded: those contacts belong to the publisher, not to the business the post names.
  const unprovenOwnBusiness = !usable && sameRow && isSuccessfulFacebookScrape(raw)
    && businessIdentity?.relationship !== 'third_party' && !raw.business?.wrongBusiness
    && !raw.scrape?.blocked && !raw.scrape?.loginRequired && !raw.scrape?.notFound;
  if (unprovenOwnBusiness && !phone.value) {
    const found = normalizeUkContactPhone(contact.phone);
    if (found && phoneUrl && !phone.candidates.some(c => c.value === found))
      phone.candidates.push({ value: found, source: phoneSource || 'actor-contact',
        sourceUrl: phoneUrl, verified: false, identityUnproven: true });
  }

  const addressUrl = sourceUrl(address.sourceUrl);
  const addressAllowed = usable && (raw.business?.identityStatus === 'matched' || businessIdentity?.status === 'matched')
    && address.verified === true && !isPublisherContact(addressUrl) &&
    ((/^facebook-(?:page|post)-contact$/.test(address.source || '') && validateFacebookUrl(addressUrl).ok) ||
     (/^google-official-website-(?:structured|address)$/.test(address.source || '') && address.identityStatus === 'matched' && addressUrl));
  const fullAddress = field(addressAllowed ? text(address.full) : '',
    submitted.address, text(address.source), addressUrl);
  const proofCandidates = usable && businessIdentity?.status === 'matched' && businessIdentity.relationship !== 'third_party'
    && raw.time_target_matched === true ? proofAddresses(raw.postText) : [];
  fullAddress.candidates = proofCandidates.map(c => ({ ...c, sourceUrl: input.value, source: 'facebook-post-contact' }));
  if (fullAddress.value) fullAddress.candidates.push({ value: fullAddress.value, sourceUrl: addressUrl, source: address.source });
  if(usable && businessIdentity?.status==='matched' && businessIdentity.relationship!=='third_party' && Array.isArray(address.candidates)) {
    for(const candidate of address.candidates.slice(0,5)) {
      const url=sourceUrl(candidate.sourceUrl),value=text(candidate.value);
      if(url && value && !fullAddress.candidates.some(c=>c.value===value && c.sourceUrl===url))
        fullAddress.candidates.push({value,sourceUrl:url,source:text(candidate.source)});
    }
  }
  fullAddress.conflict ||= address.conflict === true || proofCandidates.length > 1
    || Boolean(fullAddress.value && proofCandidates.some(c => !addressesAgree(c.value, fullAddress.value)));
  if (!fullAddress.value && proofCandidates.length === 1 && !fullAddress.conflict) {
    Object.assign(fullAddress, field(proofCandidates[0].value, submitted.address, 'facebook-post-contact', input.value, value => value.toLowerCase().replace(/\s+/g, ' ')));
  }
  // Derive a postcode only from the observed address, never a submitted fallback.
  const postcode = fullAddress.value.match(/\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i)?.[0]
    ?.toUpperCase().replace(/\s+/g, '').replace(/(.{3})$/, ' $1') || '';
  const postcodeField = field(postcode, submitted.zip, fullAddress.source, fullAddress.sourceUrl,
    value => text(value).toUpperCase().replace(/\s+/g, ''));
  const fields = [phone, fullAddress, postcodeField];
  const conflicts = fields.some(item => item.conflict);
  const complete = Boolean(phone.value && fullAddress.value);
  return {
    schemaVersion: 'cot-contact-enrichment-v1',
    searchAuthor,
    businessName: businessIdentity?.status === 'matched' ? businessIdentity.businessName : '',
    lookup: raw.contactLookup || { status: 'not_recorded' },
    status: conflicts ? 'review_required' : complete ? 'complete' : fields.some(item => item.value) ? 'partial' : 'unavailable',
    phone, address: fullAddress, postcode: postcodeField,
    requiresManualReview: conflicts || !complete,
    reviewReasons: [...(!phone.value ? ['PHONE_MISSING'] : []), ...(businessIdentity?.requiresManualReview ? ['IDENTITY_UNRESOLVED'] : []), ...(conflicts ? ['CONTACT_CONFLICT'] : [])],
    warnings: [
      ...(businessIdentity?.requiresManualReview ? [businessIdentity.reason] : []),
      ...(!sameRow ? ['Contact evidence is missing or belongs to a different proof URL.'] : []),
      ...(!phone.value ? ['No verified UK business phone was found.'] : []),
      ...(!fullAddress.value ? ['No verified business address was found.'] : []),
      ...(conflicts ? ['Contact sources disagree or differ from the submitted lead; review before export.'] : [])
    ]
  };
}

export function cotLeadWithContacts(lead, enrichment) {
  const result = { ...lead };
  if (enrichment.phone.value && !enrichment.phone.submittedValue) result['Phone Number'] = enrichment.phone.value;
  if (enrichment.address.value && !enrichment.address.submittedValue) result['Address 1'] = enrichment.address.value;
  if (enrichment.postcode.value && !enrichment.postcode.submittedValue) result['Post Code'] = enrichment.postcode.value;
  return result;
}
