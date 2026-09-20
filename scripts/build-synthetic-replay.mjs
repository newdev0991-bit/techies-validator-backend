// Build a replay set for scripts/replay-cot-quality.mjs that is larger than the
// live pipeline DB and includes GOOD / delivery-ready leads.
//
// Real leads: folded in from techies-standalone-lead-pipeline/state/pipeline.sqlite
//   when that DB is present (the same 3 completed rows the live run produced).
// Synthetic leads: built through the repo's own finalizeCotAnalysis + assess, so
//   the model verdict is fabricated but every downstream policy decision is real
//   code. Clearly-synthetic publishers ("Synthetic *"), never passed off as a
//   genuine validation history.
//
// Usage: node scripts/build-synthetic-replay.mjs <out.json>
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeCotAnalysis } from '../server.js';
import { contactTargetFromProof } from '../actor/src/contactTarget.js';
import { runGoodLeadContactPhase } from '../src/cot-contact-workflow.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2];
if (!out) throw new Error('Usage: node scripts/build-synthetic-replay.mjs <out.json>');

const HOUR = 3600000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// A proof scrape that matched the post URL exactly, with verified phone+address.
function proofRaw({ proof, caption, hoursAgo, requestKey, phone = '01632960999', address = 'Publisher premises London SW1A 1AA' }) {
  return {
    inputUrl: proof, requestKey, postUrl: proof, status: 'success', scrape: { success: true },
    facebookEvidenceUrl: 'https://www.facebook.com/syntheticpublisher',
    pageName: 'Synthetic Publisher', postAuthor: 'Synthetic Publisher', postText: caption,
    business: { identityStatus: 'matched' },
    posted_at_iso: iso(hoursAgo * HOUR),
    time_target_matched: true, time_confidence: 'high', time_target_match_method: 'direct_post_url',
    time_precision: 'exact', time_is_estimated: false,
    contact: { phone, phoneVerified: true, identityStatus: 'matched',
      phoneSource: 'facebook-page-page-text', sourceUrl: 'https://www.facebook.com/syntheticpublisher' },
    address: { full: address, verified: true, source: 'facebook-page-contact',
      sourceUrl: 'https://www.facebook.com/syntheticpublisher' },
  };
}

// Second-stage contact scrape against the resolved target business.
function withContacts(raw, identity, { address = '12 Synthetic Road, Taunton TA1 1AA', phone = '01632960123' } = {}) {
  const next = structuredClone(raw);
  next.contactTarget = { ...contactTargetFromProof(next, identity), verified: true };
  next.contactLookup = { status: 'complete', businessName: identity.businessName, required: ['phone', 'address'] };
  next.contact = { phone, phoneVerified: true, identityStatus: 'matched',
    phoneSource: 'facebook-page-page-text',
    sourceUrl: 'https://www.facebook.com/syntheticmakers/about_contact_and_basic_info' };
  next.address = { full: address, verified: true, identityStatus: 'matched',
    source: 'google-official-website-address', sourceUrl: 'https://syntheticmakers.test/contact' };
  return next;
}

async function record({ id, company, proof, caption, hoursAgo, quality, mutate }) {
  const lead = { 'Company Name': company, 'Search Post ID': id, 'Lead Proof URL': proof };
  const raw = proofRaw({ proof, caption, hoursAgo, requestKey: `row:${id}` });
  let row = { clientRowId: `row:${id}`, rowIndex: 0, success: true, lead,
    fetchResults: { rawData: raw }, analysis: finalizeCotAnalysis({ ...lead, fetchResults: { rawData: raw } }, quality) };
  // Run the real GOOD-lead contact phase so third-party targets resolve their
  // verified phone/address exactly as the live pipeline would.
  const identity = row.analysis.quality_assessment?.business_identity || quality.business_identity;
  [row] = await runGoodLeadContactPhase([row], { finalize: finalizeCotAnalysis,
    scrape: async (rows) => rows.map((r) => {
      const next = withContacts(r.fetchResults.rawData, identity);
      if (mutate) mutate(next);
      return { rawData: next };
    }) });
  if (mutate && row.fetchResults?.rawData) {
    mutate(row.fetchResults.rawData);
    row.analysis = finalizeCotAnalysis({ ...lead, fetchResults: row.fetchResults }, quality);
  }
  return { result: JSON.stringify({ status: 'REVIEW_REQUIRED', validatedAt: iso(2 * HOUR), response: row }) };
}

const good = (over) => ({ verdict: 'GOOD', reasoning: 'A new business is opening.', needs_manual_review: false,
  business_identity: { businessName: 'Synthetic Makers', relationship: 'third_party',
    evidenceQuote: 'is opening soon', locationQuote: 'Taunton' }, ...over });

const synthetic = await Promise.all([
  record({ id: 's-ready-selfr', company: 'Synthetic Publisher', hoursAgo: 4,
    proof: 'https://www.facebook.com/syntheticpublisher/posts/1001',
    caption: 'We are opening soon at our new premises in Taunton.',
    quality: good({ business_identity: { businessName: 'Synthetic Publisher', relationship: 'self',
      evidenceQuote: 'opening soon at our new premises', locationQuote: 'Taunton' } }) }),
  record({ id: 's-ready-3p', company: 'Synthetic Publisher', hoursAgo: 6,
    proof: 'https://www.facebook.com/syntheticpublisher/posts/1002',
    caption: 'Synthetic Makers is opening soon in Taunton.', quality: good() }),
  record({ id: 's-expired', company: 'Synthetic Publisher', hoursAgo: 72,
    proof: 'https://www.facebook.com/syntheticpublisher/posts/1003',
    caption: 'Synthetic Makers is opening soon in Taunton.', quality: good() }),
  record({ id: 's-review-noaddr', company: 'Synthetic Publisher', hoursAgo: 5,
    proof: 'https://www.facebook.com/syntheticpublisher/posts/1004',
    caption: 'Synthetic Makers is opening soon in Taunton.', quality: good(),
    mutate: (raw) => { raw.address.full = ''; } }),
  record({ id: 's-review-flag', company: 'Synthetic Publisher', hoursAgo: 5,
    proof: 'https://www.facebook.com/syntheticpublisher/posts/1005',
    caption: 'Synthetic Makers is opening soon in Taunton.',
    quality: good({ needs_manual_review: true }) }),
  record({ id: 's-rejected-edu', company: 'Synthetic Publisher', hoursAgo: 5,
    proof: 'https://www.facebook.com/syntheticpublisher/posts/1006',
    caption: 'Our school is opening a new sixth-form campus.',
    quality: good({ verdict: 'BAD', reasoning: 'Education sector is out of scope.' }) }),
]);

// Fold in the real completed rows + quarantine + runs when the live DB exists.
let real = { leads: [], quarantine: [], runs: [] };
const dbPath = path.join(root, '..', 'techies-standalone-lead-pipeline', 'state', 'pipeline.sqlite');
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  real.leads = db.prepare('SELECT result FROM leads WHERE result IS NOT NULL').all().map((r) => ({ result: r.result }));
  real.quarantine = db.prepare('SELECT source FROM quarantine').all().map((r) => ({ source: r.source }));
  real.runs = db.prepare('SELECT record FROM runs').all().map((r) => ({ record: r.record }));
  db.close();
} catch (e) {
  console.warn(`live DB not folded in (${e.message})`);
}

const set = { leads: [...real.leads, ...synthetic], quarantine: real.quarantine, runs: real.runs };
writeFileSync(out, JSON.stringify(set, null, 1));
console.log(`wrote ${out}: ${set.leads.length} leads (${real.leads.length} real + ${synthetic.length} synthetic), ` +
  `${set.quarantine.length} quarantine, ${set.runs.length} runs`);
