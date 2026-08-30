const GOOGLE_CONTACT_EXCLUDED_HOSTS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
  'yell.com', 'companieshouse.gov.uk', 'checkatrade.com', 'trustpilot.com',
  'nextdoor.co.uk', 'houzz.co.uk', 'bark.com', 'mybuilder.com', '192.com',
  'google.com', 'youtube.com'
];

export function normalizeGoogleEvidence(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]{2})([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function googleBusinessIdentityMatches(text, url, lead = {}) {
  const normalizedText = normalizeGoogleEvidence(text);
  const compactText = normalizedText.replace(/\s+/g, '');
  const normalizedBusinessName = normalizeGoogleEvidence(lead.name || lead.Name);
  const ignoredNameTokens = new Set(['and', 'the', 'ltd', 'limited', 'company', 'co', 'uk']);
  const expectedNameTokens = normalizedBusinessName
    .split(' ')
    .filter((token) => token.length > 1 && !ignoredNameTokens.has(token));
  const matchedNameTokens = expectedNameTokens.filter((token) => normalizedText.includes(token));
  const nameScore = expectedNameTokens.length ? matchedNameTokens.length / expectedNameTokens.length : 0;
  const expectedNamePhrase = expectedNameTokens.join(' ');
  const compactExpectedName = expectedNameTokens.join('');
  const phraseMatched = Boolean(
    expectedNamePhrase && (
      normalizedText.includes(expectedNamePhrase) ||
      compactText.includes(compactExpectedName)
    )
  );

  const postcode = String(lead.zip || lead.ZIP || lead.postcode || '').replace(/\s+/g, '').toLowerCase();
  const ignoredLocationTokens = new Set([
    'united', 'kingdom', 'england', 'scotland', 'wales', 'street', 'road', 'lane',
    'high', 'gardens', 'garden', 'avenue', 'close', 'drive', 'park', 'industrial', 'estate'
  ]);
  const locationTokens = normalizeGoogleEvidence(lead.address || lead.Address)
    .split(' ')
    .filter((token) => token.length >= 4 && !ignoredLocationTokens.has(token));
  const postcodeMatched = Boolean(postcode && compactText.includes(postcode));
  const locationMatched = postcodeMatched || locationTokens.some((token) => normalizedText.includes(token));

  let domainMatched = false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const compactHost = normalizeGoogleEvidence(host).replace(/\s+/g, '');
    domainMatched = compactExpectedName.length >= 6 && compactHost.includes(compactExpectedName);
  } catch { /* Invalid URLs cannot establish a domain match. */ }

  const nameMatched = expectedNameTokens.length >= 2 && nameScore >= 0.8 && (phraseMatched || domainMatched);
  return {
    matched: nameMatched && (locationMatched || (!postcode && !locationTokens.length && domainMatched)),
    confidence: nameMatched && (postcodeMatched || locationTokens.length > 1 || domainMatched) ? 'high' : 'medium',
    nameScore,
    phraseMatched,
    domainMatched,
    locationMatched,
    postcodeMatched
  };
}

export function isAllowedGoogleContactUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)google\.[a-z.]+$/i.test(host) || host.endsWith('.googleusercontent.com') || host.endsWith('.gstatic.com')) return false;
    return !GOOGLE_CONTACT_EXCLUDED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${  blocked}`));
  } catch {
    return false;
  }
}

export function extractGoogleContact(candidate, lead, requested = {}) {
  if (!isAllowedGoogleContactUrl(candidate.url)) return null;
  const combinedText = [candidate.title, candidate.text].filter(Boolean).join('\n');
  const identity = googleBusinessIdentityMatches(
    [candidate.identityText, combinedText].filter(Boolean).join('\n'), candidate.url, lead);
  if (!identity.matched) return null;

  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const mailtoEmail = String(candidate.mailto || '')
    .replace(/^mailto:/i, '')
    .split(/[?;]/)[0]
    .trim();
  const bodyEmails = combinedText.match(emailPattern) || [];
  const email = requested.email === false ? '' : (mailtoEmail || bodyEmails[0] || '');

  const rawTelPhone = String(candidate.tel || '')
    .replace(/^tel:/i, '')
    .split(/[?;]/)[0]
    .trim();
  let telPhone = rawTelPhone;
  try { telPhone = decodeURIComponent(rawTelPhone); } catch { /* Validate the undecoded value below. */ }
  telPhone = telPhone.replace(/^["'\s]+|["'\s]+$/g, '');
  const bodyPhones = combinedText.match(/(?:\+44\s?|0)\d(?:[\d\s().-]{7,})/g) || [];
  const isPlausiblePhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 14;
  };
  const verifiedTelPhone = isPlausiblePhone(telPhone) ? telPhone : '';
  const verifiedBodyPhone = bodyPhones.map((value) => value.trim()).find(isPlausiblePhone) || '';
  const phone = requested.phone === false ? '' : (verifiedTelPhone || verifiedBodyPhone);

  const address = requested.address ? matchedStructuredAddress(candidate.structuredAddresses, lead) : '';
  if (!email && !phone && !address) return null;
  const phoneSource = verifiedTelPhone ? 'google-official-website-tel' : 'google-official-website-labeled';
  const emailSource = mailtoEmail ? 'google-official-website-mailto' : 'google-official-website-labeled';
  return {
    phone,
    phoneVerified: Boolean(phone),
    phoneSource: phone ? phoneSource : null,
    phoneSourceUrl: phone ? candidate.url : null,
    address,
    addressVerified: Boolean(address),
    addressSource: address ? 'google-official-website-structured' : null,
    addressSourceUrl: address ? candidate.url : null,
    addressIdentityStatus: address ? 'matched' : 'unconfirmed',
    email,
    emailVerified: Boolean(email),
    emailSource: email ? emailSource : null,
    emailSourceUrl: email ? candidate.url : null,
    website: candidate.url,
    contactSource: 'google-official-website',
    contactSourceUrl: candidate.url,
    contactIdentityStatus: 'matched',
    contactIdentityConfidence: identity.confidence,
    googleIdentityEvidence: identity
  };
}

// Default callers retain the legacy cost policy. COT explicitly needs both fields.
export function googleContactRequest(result, input = {}) {
  if (input.includeGoogleFallback === false || input.includeContactDetails === false) return null;
  if (input.contactRequirements !== 'phone_address') {
    return result.phone || result.email ? null : { phone: true, email: true };
  }
  const phone = !(result.phone && result.phoneVerified === true && result.identityStatus === 'matched');
  const address = !(result.address && result.identityStatus === 'matched' && result.facebookEvidenceUrl);
  return phone || address ? { phone, address, email: false } : null;
}

const scalar = value => typeof value === 'string' ? value.trim() : '';
const postcodeKey = value => scalar(value).toUpperCase().replace(/\s/g, '');

// JSON-LD is read as data only. Require a named entity and a full UK postal address;
// ambiguous branches and incomplete free text remain unresolved.
export function readStructuredAddresses(html) {
  const found = [];
  const scripts = String(html).slice(0, 1000000).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const script of scripts) {
    let data;
    try { data = JSON.parse(script[1]); } catch { continue; }
    const pending = [data];
    for (let count = 0; pending.length && count < 1000; count++) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      pending.push(...Object.values(node).filter(v => v && typeof v === 'object'));
      if (!scalar(node.name) || !node.address) continue;
      for (const address of Array.isArray(node.address) ? node.address : [node.address]) {
        if (!address || typeof address !== 'object') continue;
        const street = scalar(address.streetAddress);
        const city = scalar(address.addressLocality);
        const postcode = scalar(address.postalCode);
        const country = scalar(address.addressCountry) || scalar(address.addressCountry?.name);
        if (!street || !city || !/^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(postcode)) continue;
        if (country && !/^(?:GB|GBR|UK|United Kingdom|England|Scotland|Wales|Northern Ireland)$/i.test(country)) continue;
        found.push({ name: node.name, postcode, full: [street, city, postcode, country].filter(Boolean).join(', ') });
      }
    }
  }
  return found;
}

function matchedStructuredAddress(addresses = [], lead = {}) {
  const name = normalizeGoogleEvidence(lead.name || lead.Name);
  const postcode = postcodeKey(lead.zip || lead.ZIP || lead.postcode);
  const candidates = addresses.filter(a => name && normalizeGoogleEvidence(a.name) === name
    && (!postcode || postcodeKey(a.postcode) === postcode));
  const unique = [...new Set(candidates.map(a => a.full))];
  return unique.length === 1 ? unique[0] : '';
}

function requestedComplete(contact, requested) {
  if (!contact) return false;
  if (!requested.address) return Boolean(contact.phone || contact.email);
  return (!requested.phone || Boolean(contact.phone)) && Boolean(contact.address);
}

// Preserve each field's provenance when combining the home and contact page.
export function mergeGoogleContact(target, incoming = {}) {
  const merged = { ...target };
  for (const field of ['phone', 'email', 'address']) {
    const unverifiedPhone = field === 'phone' && target.phoneVerified !== true;
    if ((target[field] && !unverifiedPhone) || !incoming[field]) continue;
    merged[field] = incoming[field];
    for (const suffix of ['Verified', 'Source', 'SourceUrl', 'IdentityStatus']) {
      if (incoming[field + suffix] !== undefined) merged[field + suffix] = incoming[field + suffix];
    }
  }
  if (!target.website && incoming.website) merged.website = incoming.website;
  for (const field of ['contactSource', 'contactSourceUrl', 'contactIdentityStatus',
    'contactIdentityConfidence', 'googleSearchQuery', 'googleIdentityEvidence', 'googleContactWarning']) {
    if (incoming[field]) merged[field] = incoming[field];
  }
  return Object.assign(target, merged);
}

export async function readOfficialContacts(candidate, lead, requested, { readCandidate, canRead = () => true } = {}) {
  const contact = extractGoogleContact(candidate, lead, requested);
  if (requestedComplete(contact, requested)) return contact;
  const identityText = [candidate.title, candidate.text].filter(Boolean).join('\n');
  const identity = googleBusinessIdentityMatches(identityText, candidate.url, lead);
  if (!isAllowedGoogleContactUrl(candidate.url) || !candidate.contactUrl || !canRead() ||
      identity.nameScore < 0.8 || !(identity.phraseMatched || identity.domainMatched) ||
      !isAllowedGoogleContactUrl(candidate.contactUrl)) return contact;
  const sameHost = url => new URL(url).hostname === new URL(candidate.url).hostname;
  if (!sameHost(candidate.contactUrl)) return contact;
  try {
    const page = await readCandidate(candidate.contactUrl);
    if (!sameHost(page.url)) return contact; // Redirects cannot inherit another site's identity.
    const extra = extractGoogleContact({ ...page, identityText }, lead, requested);
    return extra ? mergeGoogleContact(contact || {}, extra) : contact;
  } catch {
    return contact; // A failed follow-up must not erase already-observed evidence.
  }
}
