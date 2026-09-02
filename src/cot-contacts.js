import { normalizeLead } from './card-data.js';
import { isSuccessfulFacebookScrape, validateFacebookUrl } from './validation.js';
import { normalizeUkContactPhone } from '../actor/src/contactValues.js';
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
      : /^google-official-website/.test(phoneSource) && contact.source === 'google-official-website');
  const phone = field(phoneAllowed ? normalizeUkContactPhone(contact.phone) : '',
    submitted.phone, phoneSource, phoneUrl, normalizeUkContactPhone);
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
