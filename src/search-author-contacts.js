// Search v2 contacts describe the POST AUTHOR, not necessarily the lead business.
// Keep them as candidates; this contract has no per-field verification evidence.
import { GOOGLE_CONTACT_SOURCES } from './contact-sources.js';

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const httpUrl = value => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};

export function searchAuthorContacts(author = {}) {
  if (!author || typeof author !== 'object' || Array.isArray(author)) author = {};
  return {
    name: text(author.name, 300), id: text(author.id, 100), url: httpUrl(author.url),
    phone: text(author.phone, 80), address: text(author.address, 1000),
    email: text(author.email, 320), website: httpUrl(/^https?:\/\//i.test(text(author.website, 2000))
      ? text(author.website, 2000) : text(author.website, 2000) ? `https://${text(author.website, 2000)}` : ''),
    contactSource: ['facebook', ...GOOGLE_CONTACT_SOURCES].includes(author.contactSource) ? author.contactSource : '',
    contactIdentityConfidence: ['high', 'medium'].includes(author.contactIdentityConfidence) ? author.contactIdentityConfidence : '',
    verified: false,
  };
}

export function searchContactsFromLead(lead = {}) {
  if (!lead['Search Post ID'] || typeof lead['Search Author Contact'] !== 'string'
      || lead['Search Author Contact'].length > 6000) return null;
  try { return searchAuthorContacts(JSON.parse(lead['Search Author Contact'])); }
  catch { return null; }
}
