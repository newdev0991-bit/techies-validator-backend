import { normalizeLead } from './card-data.js';
import { isSuccessfulFacebookScrape, validateFacebookUrl } from './validation.js';

const text = value => typeof value === 'string' ? value.trim() : '';

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : '';
  } catch { return ''; }
}

export function normalizeUkContactPhone(value) {
  const raw = text(value);
  if (!/^[+\d\s().-]+$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('44')) digits = `0${digits.slice(2)}`;
  return /^0[1-9]\d{9}$/.test(digits) ? digits : '';
}

function field(value, submitted, source, url, normalize = v => text(v).toLowerCase().replace(/\s+/g, ' ')) {
  const conflict = Boolean(value && submitted && normalize(value) !== normalize(submitted));
  return { value, verified: Boolean(value), source: value ? source : '',
    sourceUrl: value ? url : '', submittedValue: submitted, conflict };
}

// Values come only from the Actor's identity-checked evidence, never model text,
// OCR guesses, or submitted fields echoed back as if they had been scraped.
export function enrichCotContacts(lead = {}) {
  const submitted = normalizeLead(lead);
  const raw = lead.fetchResults?.rawData || lead.fetchResults?.actorData || lead.fetchResults || {};
  const proof = validateFacebookUrl(submitted.link);
  const input = validateFacebookUrl(raw.inputUrl);
  const sameRow = proof.ok && input.ok && proof.value === input.value;
  const contact = raw.contact || {};
  const address = raw.address || {};
  const usable = sameRow && isSuccessfulFacebookScrape(raw)
    && !raw.scrape?.blocked && !raw.scrape?.loginRequired && !raw.scrape?.notFound
    && !raw.business?.wrongBusiness;
  const phoneUrl = sourceUrl(contact.sourceUrl);
  const phoneSource = text(contact.phoneSource);
  const phoneAllowed = usable && contact.identityStatus === 'matched'
    && contact.phoneVerified === true && phoneUrl
    && (/^facebook-/.test(phoneSource) ? validateFacebookUrl(phoneUrl).ok
      : /^google-official-website/.test(phoneSource) && contact.source === 'google-official-website');
  const phone = field(phoneAllowed ? normalizeUkContactPhone(contact.phone) : '',
    submitted.phone, phoneSource, phoneUrl, normalizeUkContactPhone);
  const addressUrl = sourceUrl(address.sourceUrl);
  const addressAllowed = usable && raw.business?.identityStatus === 'matched'
    && address.verified === true && address.source === 'facebook-page-contact'
    && validateFacebookUrl(addressUrl).ok;
  const fullAddress = field(addressAllowed ? text(address.full) : '',
    submitted.address, text(address.source), addressUrl);
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
    status: conflicts ? 'review_required' : complete ? 'complete' : fields.some(item => item.value) ? 'partial' : 'unavailable',
    phone, address: fullAddress, postcode: postcodeField,
    requiresManualReview: conflicts || !complete,
    warnings: [
      ...(!sameRow ? ['Contact evidence is missing or belongs to a different proof URL.'] : []),
      ...(!phone.value ? ['No verified UK business phone was found.'] : []),
      ...(!fullAddress.value ? ['No verified business address was found.'] : []),
      ...(conflicts ? ['Observed contact details differ from the submitted lead; review before export.'] : [])
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
