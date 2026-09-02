import { searchOutcome } from '../pipeline/search-outcome.mjs';

export function pipelineDiagnostics(store, config, gates, now) {
  const day=new Date(now).toISOString().slice(0,10), totals=store.totals(), daily=store.daily(day);
  const allowance=(used,limit)=>({used,limit:limit ?? null,remaining:limit == null ? null : Math.max(0,limit-used)});
  const budgets={searches:allowance(totals.searches,config.maxSearchRunsTotal || null),validations:allowance(totals.validations,config.maxValidationCallsTotal || null),
    dailySearches:allowance(daily.searches,config.maxSearchRunsPerDay),dailyValidations:allowance(daily.validations,config.maxValidationCallsPerDay)};
  const blockers=[...(gates?.blockers || []),...(store.get('halted') ? [store.get('halted').code] : [])];
  for (const [name,b] of Object.entries(budgets)) if (b.remaining === 0) blockers.push(`${name}_allowance_exhausted`);
  const dailyLimited=budgets.dailySearches.remaining===0 || budgets.dailyValidations.remaining===0;
  const next=Math.max(store.get('nextSearchAt',0),dailyLimited ? Date.parse(`${day}T00:00:00Z`)+86400000 : now);
  return {blockers,budgets,nextEligibleSearchAt:blockers.some(b=>!b.startsWith('daily')) ? null : new Date(next).toISOString()};
}

export function runMetrics(store) {
  const all=store.rows();
  const quarantine=store.db.prepare('SELECT cycle, count(*) n FROM quarantine GROUP BY cycle').all();
  return store.db.prepare('SELECT record FROM runs').all().map(x=>JSON.parse(x.record)).map(r=>{
    const rows=all.filter(x=>x.cycle===r.runId), validated=rows.filter(x=>x.result).map(x=>JSON.parse(x.result));
    return {runId:r.runId,query:r.input?.query || '',createdAt:new Date(r.createdAt || 0).toISOString(),outcome:searchOutcome(r),
      raw:r.total ?? null,filtered:r.metrics?.filtered ?? quarantine.find(x=>x.cycle===r.runId)?.n ?? 0,
      duplicates:r.metrics?.duplicates ?? null,retained:rows.length,validated:validated.length,
      readyAtValidation:validated.filter(x=>x.status==='READY').length,
      unresolvedContacts:validated.filter(x=>x.contacts?.status!=='complete').length,
      knownSearchCostUsd:Number.isFinite(r.usageTotalUsd) ? r.usageTotalUsd : null,
      validationCostUsd:null,smallSample:validated.length<20};
  }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

export function keywordMetrics(runs) {
  const groups=new Map();
  const fields=['raw','filtered','duplicates','retained','validated','readyAtValidation','unresolvedContacts','knownSearchCostUsd'];
  for(const r of runs) {
    let group=groups.get(r.query);
    if(!group) {group={query:r.query,cycles:0,...Object.fromEntries(fields.map(k=>[k,0]))};groups.set(r.query,group);}
    group.cycles++;
    for(const k of fields) group[k]=group[k]==null || r[k]==null ? null : group[k]+r[k];
  }
  return [...groups.values()].map(r=>({...r,validationCostUsd:null,smallSample:r.validated<20}));
}
