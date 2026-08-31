import { assess } from '../pipeline/records.mjs';

export function resultSnapshot(store,now,enabled) {
  const rows=store.rows().map(row=>{
    const lead=JSON.parse(row.lead);
    if(row.status!=='complete') return {id:row.id,company:lead['Company Name'],proofUrl:lead['Lead Proof URL'],status:'PENDING',searchRunId:row.cycle};
    const saved=JSON.parse(row.result),r=assess(saved.response,now);
    return {id:row.id,company:r.identity.status==='matched' ? r.identity.businessName || lead['Company Name'] : lead['Company Name'],
      publisher:lead['Company Name'],contactLookup:saved.response.analysis.contact_lookup || null,
      proofUrl:lead['Lead Proof URL'],status:r.status,
      verdict:r.verdict,reason:r.reason,identity:r.identity.status,
      phone:r.contacts.phone.value,address:r.contacts.address.value,postcode:r.contacts.postcode.value,
      phoneEvidenceUrl:r.contacts.phone.sourceUrl,addressEvidenceUrl:r.contacts.address.sourceUrl,
      proofDate:r.freshness.timestamp,validatedAt:saved.validatedAt,searchRunId:row.cycle,
      validUntil:r.status==='READY' ? new Date(Date.parse(r.freshness.timestamp)+86400000).toISOString() : null};
  });
  return {schemaVersion:'cot-cloud-results-v1',generatedAt:new Date(now).toISOString(),enabled,
    rows,counts:Object.fromEntries(['READY','REVIEW_REQUIRED','REJECTED','PENDING'].map(s=>[s,rows.filter(r=>r.status===s).length])),
    totals:store.totals(),halted:store.get('halted'),lastTick:store.get('lastTick'),nextSearchAt:store.get('nextSearchAt'),
    currentRunId:store.get('cycle')?.runId || null};
}
