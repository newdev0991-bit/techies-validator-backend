// Offline only: writes a separate diagnostic report, never a pipeline database/CSV.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { constrainAnalysisToEvidence } from '../server.js';
import { normalizeAiResponse } from '../src/validation.js';
import { evaluateCotIdentity, applyCotIdentityPolicy } from '../src/cot-identity.js';
import { assess } from '../pipeline/records.mjs';

const [input, output, asOf] = process.argv.slice(2);
if (!input || !output || !Number.isFinite(Date.parse(asOf))) {
  throw new Error('Usage: node scripts/replay-cot-evidence.mjs response.json separate-report.json ISO-as-of');
}
const source = realpathSync(input);
const destination = path.join(realpathSync(path.dirname(path.resolve(output))), path.basename(output));
if (destination.toLowerCase() === source.toLowerCase() || /[\\/](?:canary-data|canary-output)[\\/]/i.test(destination)) {
  throw new Error('Refusing to overwrite historical canary evidence.');
}
const bytes = readFileSync(source);
const payload = JSON.parse(bytes);
if (!Array.isArray(payload.results)) throw new Error('Expected saved batch results.');
const rows = payload.results.map(row => {
  const lead = { ...row.lead, fetchResults: row.fetchResults };
  const identity = evaluateCotIdentity(lead, row.analysis.business_identity);
  const analysis = { ...row.analysis,
    ...applyCotIdentityPolicy(constrainAnalysisToEvidence(normalizeAiResponse(row.analysis), lead), identity) };
  const result = assess({ ...row, analysis }, Date.parse(asOf));
  return { postId: row.lead['Search Post ID'], publisher: row.lead['Company Name'],
    historicalVerdict: row.analysis.verdict, offlineVerdict: analysis.verdict,
    identityStatus: identity.status, identityReason: identity.reason,
    historySampleSize: analysis.post_history_analysis.total_posts,
    pageMaturity: analysis.post_history_analysis.page_maturity,
    contactStatus: result.contacts.status, disposition: result.status };
});
if (!bytes.equals(readFileSync(source))) throw new Error('Source changed during replay.');
const report = { mode: 'offline-policy-replay', asOf, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  providerCalls: 0, limitations: 'Reuses the saved model response and scraped evidence. No new identity or contact observations; not a live enrichment test.',
  counts: Object.fromEntries(['READY','REVIEW_REQUIRED','REJECTED'].map(status => [status, rows.filter(r => r.disposition === status).length])), rows };
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
