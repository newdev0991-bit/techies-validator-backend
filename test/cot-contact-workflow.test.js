import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGoodLeadContactPhase } from '../src/cot-contact-workflow.js';
import { finalizeCotAnalysis } from '../server.js';
import { contactTargetFromProof } from '../actor/src/contactTarget.js';
import { cotActorPhaseOptions } from '../src/pipeline-capabilities.js';
import { buildCotActorInput } from '../src/cot-batch.js';
import { buildActorRequests } from '../actor/src/batchRequests.js';
import { assess } from '../pipeline/records.mjs';
import { Store } from '../pipeline/store.mjs';
import { exportFiles } from '../pipeline/exports.mjs';
import { resultSnapshot } from '../cloud/results.mjs';

function fixture() {
  const proof = 'https://www.facebook.com/syntheticpublisher/posts/12345';
  const caption = 'Synthetic Makers is opening soon in Taunton.';
  const raw = { inputUrl: proof, requestKey: 'row:0', postUrl: proof, status: 'success', scrape: { success: true },
    facebookEvidenceUrl: 'https://www.facebook.com/syntheticpublisher',
    pageName: 'Synthetic Publisher', postAuthor: 'Synthetic Publisher', postText: caption,
    business: { identityStatus: 'matched' }, posted_at_iso: new Date(Date.now() - 3600000).toISOString(),
    time_target_matched: true, time_confidence: 'high', time_target_match_method: 'direct_post_url', time_precision: 'exact', time_is_estimated: false,
    contact: { phone: '01632960999', phoneVerified: true, identityStatus: 'matched', phoneSource: 'facebook-page-page-text', sourceUrl: 'https://www.facebook.com/syntheticpublisher' },
    address: { full: 'Publisher premises London SW1A 1AA', verified: true, source: 'facebook-page-contact', sourceUrl: 'https://www.facebook.com/syntheticpublisher' } };
  const lead = { 'Company Name': 'Synthetic Publisher', 'Search Post ID': '12345', 'Lead Proof URL': proof };
  const quality = { verdict: 'GOOD', reasoning: 'A new business is opening.', needs_manual_review: false,
    business_identity: { businessName: 'Synthetic Makers', relationship: 'third_party', evidenceQuote: caption, locationQuote: 'Taunton' } };
  return { clientRowId: 'row:0', rowIndex: 0, success: true, lead, fetchResults: { rawData: raw },
    analysis: finalizeCotAnalysis({ ...lead, fetchResults: { rawData: raw } }, quality) };
}

function contacts(row) {
  const raw = structuredClone(row.fetchResults.rawData);
  raw.contactTarget = { ...contactTargetFromProof(raw, row.analysis.quality_assessment.business_identity), verified: true };
  raw.contactLookup = { status: 'complete', businessName: 'Synthetic Makers', required: ['phone', 'address'] };
  raw.contact = { phone: '01632960123', phoneVerified: true, identityStatus: 'matched',
    phoneSource: 'facebook-page-page-text', sourceUrl: 'https://www.facebook.com/syntheticmakers/about_contact_and_basic_info' };
  raw.address = { full: '12 Synthetic Road, Taunton TA1 1AA', verified: true, identityStatus: 'matched',
    source: 'google-official-website-address', sourceUrl: 'https://syntheticmakers.test/contact' };
  return { rawData: raw };
}

test('GOOD opportunity behind a third-party publisher becomes delivery-ready only after target phone/address scraping', async t => {
  const row = fixture();
  assert.equal(row.analysis.verdict, 'UNCLEAR');
  assert.equal(row.analysis.quality_assessment.verdict, 'GOOD');
  assert.equal(row.analysis.contact_enrichment.status, 'unavailable');
  let calls = 0;
  const [result] = await runGoodLeadContactPhase([row], { finalize: finalizeCotAnalysis, scrape: async rows => {
    calls++;
    assert.equal(rows[0].contactTarget.businessName, 'Synthetic Makers');
    assert.equal(rows[0].lead['Company Name'], 'Synthetic Publisher');
    const input = buildCotActorInput(rows.map(r => ({ requestKey: r.clientRowId, url: r.fetchResults.rawData.inputUrl, lead: {}, contactTarget: r.contactTarget })), { phase: 'contacts' });
    assert.equal(buildActorRequests(input)[0].contactTarget.businessName, 'Synthetic Makers');
    return rows.map(contacts);
  } });
  assert.equal(calls, 1);
  assert.equal(result.analysis.verdict, 'GOOD');
  assert.equal(result.analysis.needs_manual_review, false);
  assert.equal(result.analysis.business_identity.relationship, 'third_party');
  assert.equal(result.analysis.contact_enrichment.phone.value, '01632960123');
  assert.equal(result.lead['Company Name'], 'Synthetic Publisher');
  const classified = assess(result, Date.now());
  assert.equal(classified.status, 'READY');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cot-target-export-'));
  const store = new Store(dir); t.after(() => store.close());
  store.insert('12345', 'search', {}, result.lead, Date.now());
  store.db.prepare("UPDATE leads SET status='complete',result=? WHERE id=?").run(JSON.stringify(classified), '12345');
  const snapshot = resultSnapshot(store, Date.now(), false);
  assert.equal(snapshot.rows[0].company, 'Synthetic Makers');
  assert.equal(snapshot.rows[0].publisher, 'Synthetic Publisher');
  assert.equal(snapshot.rows[0].phone, '01632960123');
  await exportFiles(store, path.join(dir, 'output'), Date.now());
  const csv = readFileSync(path.join(dir, 'output/enriched.csv'), 'utf8');
  assert.match(csv, /Synthetic Makers/); assert.doesNotMatch(csv, /01632960999/);
});

test('rejected, uncertain, stale, already complete, and unresolvable evidence do not spend another contact call', async () => {
  const bad = fixture(); bad.analysis.quality_assessment.verdict = 'BAD';
  const unclear = fixture(); unclear.analysis.quality_assessment.verdict = 'UNCLEAR';
  const stale = fixture(); stale.analysis.freshness.decision = 'stale';
  const unknown = fixture(); unknown.analysis.quality_assessment.business_identity.evidenceQuote = 'Invented';
  const complete = fixture(); complete.fetchResults = contacts(complete);
  complete.analysis = finalizeCotAnalysis({ ...complete.lead, fetchResults: complete.fetchResults }, complete.analysis.quality_assessment);
  await runGoodLeadContactPhase([bad, unclear, stale, unknown, complete], { finalize: finalizeCotAnalysis,
    scrape: async () => assert.fail('No eligible work') });
});

test('missing address, wrong target binding and publisher contacts can never make a good opportunity READY', async () => {
  for (const mutate of [raw => { raw.address.full = ''; }, raw => { raw.contactTarget.businessName = 'Wrong business'; },
    raw => { raw.contact.sourceUrl = raw.facebookEvidenceUrl + '/about'; },
    raw => { raw.postText = 'The opening has been cancelled.'; }]) {
    const row = fixture();
    const [result] = await runGoodLeadContactPhase([row], { finalize: finalizeCotAnalysis, scrape: async () => {
      const fetched = contacts(row); mutate(fetched.rawData); return [fetched];
    } });
    assert.equal(assess(result, Date.now()).status, 'REVIEW_REQUIRED');
  }
});

test('uncertain contact-run failure and mismatched rows settle in review without provider retry', async () => {
  for (const mismatched of [false, true]) {
    let calls = 0;
    const row = fixture();
    const [result] = await runGoodLeadContactPhase([row], { finalize: finalizeCotAnalysis, scrape: async () => {
      calls++; if (!mismatched) throw new Error('Provider outcome unknown');
      const fetched = contacts(row); fetched.rawData.requestKey = 'other'; return [fetched];
    } });
    assert.equal(calls, 1);
    assert.equal(result.analysis.contact_lookup.status, 'failed_no_automatic_retry');
    assert.equal(assess(result, Date.now()).status, 'REVIEW_REQUIRED');
  }
});

test('two-stage run caps sum to the existing batch allowance and duration; no unbounded fallback', () => {
  const env = { COT_ACTOR_MAX_CHARGE_USD: '0.20' };
  const first = cotActorPhaseOptions('proof', env), second = cotActorPhaseOptions('contacts', env);
  assert.equal(first.maxTotalChargeUsd + second.maxTotalChargeUsd, .20);
  assert.equal(first.timeout + second.timeout, 300);
  assert.equal(first.restartOnError, false); assert.equal(second.restartOnError, false);
  assert.throws(() => cotActorPhaseOptions('contacts', {}));
  assert.equal(buildCotActorInput([], { phase: 'proof' }).includeGoogleFallback, false);
  assert.equal(buildCotActorInput([], { phase: 'proof' }).includeContactDetails, false);
});
