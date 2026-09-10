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
    // Post age no longer decides whether we look a contact up. The gate used to require
    // `decision === 'fresh'`, and FRESHNESS_THRESHOLD_HOURS is 24 -- so a GOOD lead more
    // than a day old was never given a phone lookup at all, and landed in review with
    // `contacts: unavailable`. That contradicts the revised spec this same codebase
    // already adopted for the verdict ("Freshness is a priority signal, not an automatic
    // eligibility gate", see applyFreshnessPolicy): the model stopped auto-rejecting on
    // age, but the contact phase kept gating on it, so the lead survived only to arrive
    // uncontactable. A stale lead is lower priority, not less entitled to its number.
    //
    // `requiresManualReview` is deliberately still a gate, and is the same condition
    // assess() uses to withhold READY: it fires on missing, imprecise, conflicting or
    // estimated timestamps -- the quality of the evidence, not the age of the post --
    // and we should not spend a paid lookup on a row whose proof we cannot place in time.
    if (row.analysis.freshness?.requiresManualReview) {
      row.analysis.contact_lookup = { status: 'identity_or_proof_unresolved', required: ['phone', 'address'] };
      row.analysis.contact_enrichment.lookup = row.analysis.contact_lookup;
      continue;
    }
    // An unproven identity is not the same hazard as a wrong one, and the two used to be
    // refused together because `contactTargetFromProof` returns null for both.
    //
    // `third_party` means the post promotes a DIFFERENT business than the page that
    // published it, so the publisher's contacts belong to someone else. Looking them up
    // and attributing them is the misattribution this module exists to prevent. Still
    // refused.
    //
    // Everything else that fails to resolve is an OWN-business post we could not tie to a
    // Page -- typically a personal profile. Per the personal-profile parity rules the
    // verdict already survives that, but the contact phase still skipped it, which is why
    // most of the review queue carries `contacts: unavailable` with nothing for a reviewer
    // to act on. We now look it up, with no contactTarget: the Actor gathers what the
    // proof page itself publishes rather than being pointed at a named business we have
    // not proven. enrichCotContacts keeps such results as unverified candidates, never as
    // a verified contact, so an unresolved lead still cannot reach READY unattended.
    const relationship = quality.business_identity?.relationship;
    if (!target && relationship === 'third_party') {
      row.analysis.contact_lookup = { status: 'identity_or_proof_unresolved', required: ['phone', 'address'] };
      row.analysis.contact_enrichment.lookup = row.analysis.contact_lookup;
      continue;
    }
    candidates.push({ ...row, ...(target ? { contactTarget: target } : {}), position });
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
