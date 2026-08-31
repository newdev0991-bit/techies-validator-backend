import { contactTargetFromProof } from '../actor/src/contactTarget.js';
import { enrichCotContacts } from './cot-contacts.js';
import { evaluateCotIdentity } from './cot-identity.js';

// One bounded contact batch after quality analysis. No second model call and no
// automatic retries. Publisher data never becomes the promoted business's data.
export async function runGoodLeadContactPhase(results, { scrape, finalize }) {
  const candidates = [];
  for (let position = 0; position < results.length; position++) {
    const row = results[position];
    const quality = row.analysis.quality_assessment || row.analysis;
    if (quality.verdict !== 'GOOD') continue;
    const lead = { ...row.lead, fetchResults: row.fetchResults };
    const raw = row.fetchResults?.rawData;
    const target = contactTargetFromProof(raw, quality.business_identity);
    const contacts = enrichCotContacts(lead, evaluateCotIdentity(lead, quality.business_identity));
    if (contacts.status === 'complete' && !contacts.requiresManualReview) {
      row.analysis.contact_lookup = { status: 'complete_from_proof', required: ['phone', 'address'] };
      row.analysis.contact_enrichment.lookup = row.analysis.contact_lookup;
      continue;
    }
    if (!target || row.analysis.freshness?.decision !== 'fresh' || row.analysis.freshness?.requiresManualReview) {
      row.analysis.contact_lookup = { status: 'identity_or_proof_unresolved', required: ['phone', 'address'] };
      row.analysis.contact_enrichment.lookup = row.analysis.contact_lookup;
      continue;
    }
    candidates.push({ ...row, contactTarget: target, position });
  }
  if (!candidates.length) return results;
  let fetched;
  try {
    fetched = await scrape(candidates);
    if (!Array.isArray(fetched) || fetched.length !== candidates.length) throw new Error('contact-batch-mismatch');
    for (let i = 0; i < fetched.length; i++) {
      if (fetched[i]?.rawData?.inputUrl !== candidates[i].fetchResults.rawData.inputUrl ||
          fetched[i]?.rawData?.requestKey !== candidates[i].clientRowId ||
          fetched[i]?.rawData?.postText !== candidates[i].fetchResults.rawData.postText ||
          fetched[i]?.rawData?.posted_at_iso !== candidates[i].fetchResults.rawData.posted_at_iso ||
          !fetched[i]?.rawData?.contactLookup) throw new Error('contact-row-mismatch');
    }
  } catch {
    // The provider may have charged already. Return reviewable settled evidence;
    // retrying the whole validation batch must not silently pay for another lookup.
    for (const row of candidates) {
      results[row.position].analysis.needs_manual_review = true;
      results[row.position].analysis.contact_lookup = { status: 'failed_no_automatic_retry', required: ['phone', 'address'] };
      results[row.position].analysis.contact_enrichment.lookup = results[row.position].analysis.contact_lookup;
    }
    return results;
  }
  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const quality = row.analysis.quality_assessment || row.analysis;
    const analysis = finalize({ ...row.lead, fetchResults: fetched[i] }, {
      ...row.analysis, ...quality,
    });
    results[row.position] = { clientRowId: row.clientRowId, rowIndex: row.rowIndex,
      success: true, lead: row.lead, fetchResults: fetched[i], analysis };
  }
  return results;
}
