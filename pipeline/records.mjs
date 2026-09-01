import { validateFacebookUrl } from '../src/validation.js';
import { enrichCotContacts } from '../src/cot-contacts.js';
import { evaluateLeadFreshness } from '../src/freshness.js';
import { evaluateCotIdentity } from '../src/cot-identity.js';
import { searchAuthorContacts } from '../src/search-author-contacts.js';

const normalizeCaption = value => (typeof value === 'string' ? value : '')
  .slice(0, 10000).toLowerCase().replace(/[’‘]/g, "'");

export function qualifySearchPost(post) {
  const caption = normalizeCaption(post?.message);
  if (!caption) return { qualified: false, reason: 'missing_caption' };

  // These phrases overwhelmingly described people, housing or employment in the
  // observed search sample. They are safe to remove before paid validation.
  const personal = /\b(?:willing to relocate|looking to relocate|open to relocat|seeking (?:a |an )?(?:job|role)|job search|curriculum vitae|cv\b|resume\b|moving (?:house|home)|i am moving|i'm moving|moving to (?:the|a) area)\b/.test(caption);
  if (personal) return { qualified: false, reason: 'personal_or_employment_move' };

  const signals = {
    premises: /\b(?:our|the|brand new|new)\s+premises\b|\bpremises (?:are|is) (?:now )?open\b/.test(caption),
    opening: /\b(?:grand opening|soft opening|opening our (?:doors|shop|store|salon|clinic|studio|restaurant|cafe|business|new location)|(?:we(?:'re| are)|our (?:shop|store|salon|clinic|studio|restaurant|cafe|business) is) opening|until we open|we are now open|now open at)\b/.test(caption),
    relocation: /\b(?:we(?:'ve| have) (?:now )?(?:moved|relocated)|we are moving to our new (?:location|premises|address)|relocated to [^.\n]{0,80}(?:our new address|new premises)|moving (?:our|the) (?:business|shop|store|salon|clinic|studio|restaurant|cafe|office)|new business address)\b/.test(caption),
    ownership: /\b(?:under new ownership|under new management|new owners? (?:of|at)|taken over (?:the|by))\b/.test(caption)
  };
  const signal = Object.keys(signals).find(key => signals[key]);
  return signal ? { qualified: true, signal } : { qualified: false, reason: 'no_explicit_business_event' };
}

export function searchLead(post) {
  if (!['facebook-search-posts-v1', 'facebook-search-posts-v2'].includes(post?.schemaVersion) || typeof post.post_id !== 'string'
      || !/^[A-Za-z0-9_:-]{1,100}$/.test(post.post_id)) throw new Error('INVALID_SEARCH_POST_ID');
  const url = validateFacebookUrl(post.url);
  if (!url.ok || typeof post.author?.name !== 'string' || !post.author.name.trim()) throw new Error('MISSING_POST_URL_OR_AUTHOR');
  const author = searchAuthorContacts(post.schemaVersion === 'facebook-search-posts-v2' ? post.author : { name: post.author.name, id: post.author.id, url: post.author.url });
  const postcode = author.address.match(/\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i)?.[0] || '';
  return { 'Company Name': post.author.name.trim(), 'Lead Proof URL': url.value,
    'Lead Statement': typeof post.message === 'string' ? post.message : '',
    'Phone Number': author.phone, 'Address 1': author.address, 'Post Code': postcode,
    'Search Schema Version': post.schemaVersion,
    'Search Author Contact': JSON.stringify(author),
    'Search Post ID': post.post_id,
    'Search Posted At': typeof post.posted_at === 'string' ? post.posted_at : '',
    'Search Query': typeof post.query === 'string' ? post.query : '',
    'Search Identity Status': 'Candidate author name; business identity not yet verified' };
}

export function validateResponse(payload, expected) {
  if (payload?.success !== true || payload.batchId !== expected.batchId
      || !Array.isArray(payload.results) || payload.results.length !== expected.leads.length) throw new Error('BATCH_CONTRACT_MISMATCH');
  return payload.results.map((r, i) => {
    const e = expected.leads[i];
    if (r?.success !== true || r.clientRowId !== e.clientRowId || r.rowIndex !== e.rowIndex
        || !r.analysis || r.analysis.contact_enrichment?.schemaVersion !== 'cot-contact-enrichment-v1'
        || !['GOOD','BAD','UNCLEAR'].includes(r.analysis.verdict)
        || !r.lead || Object.keys(e.lead).some(k => e.lead[k] !== r.lead[k])) throw new Error('BATCH_CONTRACT_MISMATCH');
    return r;
  });
}

export function assess(row, now) {
  const lead = { ...row.lead, fetchResults: row.fetchResults };
  const identity = evaluateCotIdentity(lead, row.analysis.business_identity);
  const contacts = enrichCotContacts(lead, identity);
  // Re-evaluate the real proof evidence. Neither search dates nor an AI verdict
  // can promote an unproven timestamp to delivery-ready.
  const freshness = evaluateLeadFreshness(lead, { now: new Date(now) });
  const analysis = row.analysis;
  const ready = analysis.verdict === 'GOOD' && analysis.needs_manual_review === false
    && freshness.decision === 'fresh' && !freshness.requiresManualReview
    && contacts.status === 'complete' && !contacts.requiresManualReview && !identity.requiresManualReview;
  return { status: ready ? 'READY' : analysis.verdict === 'BAD' || freshness.autoRejectEligible ? 'REJECTED' : 'REVIEW_REQUIRED',
    contacts, freshness, identity, verdict: analysis.verdict,
    reason: `${analysis.reasoning || ''} [Freshness: ${freshness.reasonCode}; contacts: ${contacts.status}; business identity: ${identity.status}]`,
    validatedAt: new Date(now).toISOString(), response: row };
}
