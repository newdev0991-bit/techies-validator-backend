import { normalizeUkContactPhone } from '../actor/src/contactValues.js';

// Web contact recovery. Runs AFTER the Actor's own contact phase, only for leads it
// could not find a number for, and only when explicitly switched on.
//
// Why this is a separate phase rather than tools on the verdict call
// ------------------------------------------------------------------
// The validator's whole design separates "the model judges the opportunity" from "the
// evidence layer gathers facts". buildPrompt() says so out loud: missing contacts
// trigger deterministic scraping, never an invented contact. Giving the judging call a
// browser would blur that, and would pay for search on every lead. This phase pays only
// for the leads that reached the end of the Actor lookup still uncontactable, which is
// the review queue -- a small fraction of intake.
//
// What a recovered number is, and is not
// --------------------------------------
// It is a CANDIDATE. It never becomes `phone.value`, never changes `status`,
// `requiresManualReview` or `reviewReasons`, and so can never carry a lead to READY on
// its own. A human confirms it. That keeps the rule enrichCotContacts is built on --
// values come only from identity-checked evidence, never model text -- exactly intact,
// because nothing here writes a value.
//
// Every candidate must carry the URL the number was read from. A number nobody can
// trace is not evidence; it is the same standard `contact_not_verifiable_at_url`
// already applies to submitted numbers. The provider proves this rather than asserting
// it: the URL the model names must also appear in the search tool's own citation list,
// which the model does not author. A number whose source the model cannot point to in
// its citations is discarded rather than shown to a reviewer.

export const WEB_RECOVERY_SOURCE = 'web-search';

const text = value => (typeof value === 'string' ? value.trim() : '');

function httpUrl(value) {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** The business a lookup should be run for, or '' when we should not run one. */
export function recoveryTarget(row) {
  const quality = row?.analysis?.quality_assessment || row?.analysis || {};
  if (quality.verdict !== 'GOOD') return '';
  // A post promoting a different business: its publisher's contacts are not this
  // lead's, and searching the web for "the business named in someone else's post"
  // is exactly the attribution we refuse elsewhere.
  const identity = quality.business_identity || {};
  if (identity.relationship === 'third_party') return '';
  if (row?.analysis?.freshness?.requiresManualReview) return '';
  const contacts = row?.analysis?.contact_enrichment;
  // Only leads the Actor left without a number. A verified phone is never second-guessed.
  if (!contacts || text(contacts.phone?.value)) return '';
  return text(identity.businessName) || text(row?.lead?.['Company Name']);
}

/**
 * @param {object[]} results        validated rows, mutated in place
 * @param {function} search         async (business, {location}) => {phone, sourceUrl, isBranchSpecific, citations[]}
 * @param {number}   maxLookups     hard ceiling on paid searches per batch
 */
export async function runWebContactRecovery(results, { search, maxLookups = 10 } = {}) {
  if (typeof search !== 'function') return results;
  let spent = 0;

  for (const row of results) {
    const business = recoveryTarget(row);
    if (!business) continue;
    if (spent >= maxLookups) {
      setLookup(row, { status: 'web_recovery_budget_exhausted' });
      continue;
    }

    const identity = (row.analysis.quality_assessment || row.analysis).business_identity || {};
    spent++;
    let found;
    try {
      found = await search(business, { location: text(identity.locationQuote) });
    } catch {
      // A failed search is not a failed lead. Record it and move on; never retry
      // automatically, because the provider may already have charged for the call.
      setLookup(row, { status: 'web_recovery_failed', business });
      continue;
    }

    const phone = normalizeUkContactPhone(text(found?.phone));
    const sourceUrl = httpUrl(found?.sourceUrl);
    const cited = (found?.citations || []).map(c => httpUrl(c?.url)).filter(Boolean);
    if (!phone || !sourceUrl || !cited.includes(sourceUrl)) {
      setLookup(row, {
        status: 'web_recovery_no_traceable_number',
        business,
        ...(phone && !sourceUrl ? { discarded: 'number_without_source' } : {}),
        ...(phone && sourceUrl && !cited.includes(sourceUrl) ? { discarded: 'source_not_in_citations' } : {})
      });
      continue;
    }

    const contacts = row.analysis.contact_enrichment;
    contacts.phone.candidates = contacts.phone.candidates || [];
    if (!contacts.phone.candidates.some(c => c.value === phone)) {
      contacts.phone.candidates.push({
        value: phone,
        source: WEB_RECOVERY_SOURCE,
        sourceUrl,
        verified: false,
        identityUnproven: identity.relationship !== 'self' || undefined,
        // Web lookup returns central and head-office lines, and a head-office number is
        // already a rejection reason (head_office_address). The model is asked whether
        // the number is specific to this premises; anything short of an explicit yes is
        // surfaced so a reviewer checks it rather than dialling a switchboard.
        branchSpecific: found?.isBranchSpecific === true,
        // Web evidence shows a number is published for the business, not that it rings.
        callTested: false
      });
    }
    setLookup(row, { status: 'web_recovery_candidate', business, sourceUrl,
      branchSpecific: found?.isBranchSpecific === true });
  }

  return results;
}

// Recorded alongside the Actor's own lookup result rather than replacing it, so an
// operator can tell "the Actor found nothing" from "the Actor found nothing and the web
// did not either".
function setLookup(row, webRecovery) {
  const existing = row.analysis.contact_lookup || { status: 'not_recorded' };
  row.analysis.contact_lookup = { ...existing, webRecovery };
  if (row.analysis.contact_enrichment) row.analysis.contact_enrichment.lookup = row.analysis.contact_lookup;
}
