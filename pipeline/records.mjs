import { validateFacebookUrl } from '../src/validation.js';
import { enrichCotContacts } from '../src/cot-contacts.js';
import { evaluateLeadFreshness } from '../src/freshness.js';
import { evaluateCotIdentity } from '../src/cot-identity.js';
import { searchAuthorContacts } from '../src/search-author-contacts.js';

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
