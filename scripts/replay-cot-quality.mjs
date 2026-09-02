// Offline evidence replay: no providers, model calls, or live state writes.
import { readFile } from 'node:fs/promises';
import { assess, qualifySearchPost } from '../pipeline/records.mjs';
import { evaluateCotIdentity } from '../src/cot-identity.js';
import { enrichCotContacts } from '../src/cot-contacts.js';
import { searchOutcome } from '../pipeline/search-outcome.mjs';

const input=JSON.parse(await readFile(process.argv[2], 'utf8'));
const now=Date.parse(process.argv[3] || new Date().toISOString());
if (!Number.isFinite(now) || !Array.isArray(input.leads)) throw new Error('Invalid replay input');
const counts={}, original={}, recoverable=[];
for (const row of input.leads) {
  if (!row.result) continue;
  const saved=JSON.parse(row.result), response=saved.response;
  original[saved.status]=(original[saved.status] || 0)+1;
  const current=assess(response,now);counts[current.status]=(counts[current.status] || 0)+1;
  const lead={...response.lead,fetchResults:response.fetchResults};
  const claim=response.analysis.quality_assessment?.business_identity || response.analysis.business_identity;
  const identity=evaluateCotIdentity(lead,claim), contacts=enrichCotContacts(lead,identity);
  if (/SE Medical|Deeside Kilts|Corinium-Paints/.test(lead['Company Name']))
    recoverable.push({company:lead['Company Name'],identity:identity.status,contacts:contacts.status,
      address:contacts.address.value,addressConflict:contacts.address.conflict,currentStatus:current.status});
}
const newlyRetained=(input.quarantine || []).map(x=>JSON.parse(x.source)).filter(p=>qualifySearchPost(p).qualified).map(p=>p.author?.name);
const runs=(input.runs || []).map(x=>JSON.parse(x.record)).map(r=>({runId:r.runId,query:r.input?.query,outcome:searchOutcome(r)}));
console.log(JSON.stringify({offline:true,evaluatedAt:new Date(now).toISOString(),rows:input.leads.length,originalAtValidation:original,
  currentCounts:counts,recoverable,newlyRetained,runs,paidCalls:0},null,2));
