import { assess } from '../pipeline/records.mjs';
import { searchContactsFromLead } from '../src/search-author-contacts.js';
import { pipelineDiagnostics, runMetrics, keywordMetrics } from './diagnostics.mjs';

export function resultSnapshot(store,now,enabled,config={},gates) {
  const rows=store.rows().map(row=>{
    const lead=JSON.parse(row.lead);
    const searchAuthor=searchContactsFromLead(lead);
    if(row.status!=='complete') return {id:row.id,company:lead['Company Name'],proofUrl:lead['Lead Proof URL'],status:'PENDING',searchRunId:row.cycle,searchAuthor};
    const saved=JSON.parse(row.result),r=assess(saved.response,now);
    return {id:row.id,company:r.identity.status==='matched' ? r.identity.businessName || lead['Company Name'] : lead['Company Name'],
      publisher:lead['Company Name'],contactLookup:saved.response.analysis.contact_lookup || null,searchAuthor,
      proofUrl:lead['Lead Proof URL'],status:r.status,
      verdict:r.verdict,reason:r.reason,identity:r.identity.status,
      qualityVerdict:r.qualityVerdict,validationStatus:saved.status,
      freshness:{decision:r.freshness.decision,conclusive:!r.freshness.requiresManualReview,
        expiresConclusively:!r.freshness.requiresManualReview && r.freshness.source?.trusted===true
        && r.freshness.source?.precision==='instant' && r.freshness.source?.confidence>=85 && r.freshness.source?.decisionGrade===true},
      addressConflict:r.contacts.address.conflict,addressCandidates:r.contacts.address.candidates || [],
      phone:r.contacts.phone.value,address:r.contacts.address.value,postcode:r.contacts.postcode.value,
      phoneEvidenceUrl:r.contacts.phone.sourceUrl,addressEvidenceUrl:r.contacts.address.sourceUrl,
      proofDate:r.freshness.timestamp,validatedAt:saved.validatedAt,searchRunId:row.cycle,
      validUntil:r.freshness.timestamp && !r.freshness.requiresManualReview ? new Date(Date.parse(r.freshness.timestamp)+86400000).toISOString() : null};
  });
  const metrics=runMetrics(store);
  return {schemaVersion:'cot-cloud-results-v2',generatedAt:new Date(now).toISOString(),enabled,
    diagnostics:pipelineDiagnostics(store,config,gates,now),runMetrics:metrics,keywordMetrics:keywordMetrics(metrics),
    rows,counts:Object.fromEntries(['READY','REVIEW_REQUIRED','REJECTED','PENDING','EXPIRED'].map(s=>[s,rows.filter(r=>r.status===s).length])),
    totals:store.totals(),halted:store.get('halted'),lastTick:store.get('lastTick'),nextSearchAt:store.get('nextSearchAt'),
    currentRunId:store.get('cycle')?.runId || null};
}
