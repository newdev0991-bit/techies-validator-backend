// Diagnostics never change activation, budgets, counters, or provider behavior.
export function processingGates(input, requested, env) {
  const blockers=[];
  if(input.enabled!==true) blockers.push('Input Allow processing is off');
  if(requested.enabled!==true) blockers.push('CONFIG.enabled is not true');
  if(env.PIPELINE_LIVE_ENABLED!=='true') blockers.push('PIPELINE_LIVE_ENABLED is not true');
  return {enabled:blockers.length===0,blockers};
}

export function controllerReport(outcome,view,config,gates,storageId) {
  const allowance=(used,limit)=>({used,limit:limit||null,remaining:limit?Math.max(0,limit-used):null});
  const budget={searches:allowance(view.totals.searches,config.maxSearchRunsTotal),
    validations:allowance(view.totals.validations,config.maxValidationCallsTotal)};
  const savedLeadCount=Object.values(view.counts).reduce((sum,n)=>sum+n,0);
  const status=outcome.status;
  const safeCode=value=>/^[a-zA-Z0-9_-]{1,100}$/.test(value||'')?value:'unknown';
  const message=status==='disabled'
    ? `Paused: ${gates.blockers.join('; ')}. ${savedLeadCount} saved leads. No search or validation attempted.`
    : status==='total_search_limit'||status==='total_validation_limit'
      ? `Lifetime allowance exhausted (${status==='total_search_limit'?'search':'validation'}). ${savedLeadCount} saved leads. New work needs an approved budget; do not reset counters.`
      : status==='preflight_retry'||status==='preflight_backoff'
        ? `Readiness check delayed (${safeCode(outcome.code)}), ${outcome.attempts}/3 attempts used. Next check: ${new Date(outcome.nextAttemptAt).toISOString()}. No search or validation submitted. ${savedLeadCount} saved leads.`
      : `Controller step: ${safeCode(status)}${outcome.code?` (${safeCode(outcome.code)})`:''}. ${savedLeadCount} saved leads; these are cumulative, not new results from this run.`;
  return {status, message, generatedAt:view.generatedAt, processing:gates,
    diagnostics:view.diagnostics,latestCycle:view.runMetrics?.[0] || null,
    ...(status==='recovery_plan'||status==='recovered'?{recovery:outcome}:{}),
    counts:view.counts,savedLeadCount,totals:view.totals,lifetimeBudget:budget,storageId,
    ...(outcome.code?{code:safeCode(outcome.code)}:{}),
    ...(outcome.runId?{runId:outcome.runId}:{}),
    resultsRecord:'RESULTS',resultsAreCumulative:true};
}

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function reportHtml(report) {
  const counts=report.counts?Object.entries(report.counts).map(([status,count])=>`<li>${escape(status)}: ${escape(count)}</li>`).join(''):'';
  const budgets=report.lifetimeBudget?Object.entries(report.lifetimeBudget).map(([kind,b])=>`<li>${escape(kind)}: ${escape(b.used)} used; ${b.remaining===null?'no lifetime cap (other limits still apply)':`${escape(b.remaining)} remaining of ${escape(b.limit)}`}</li>`).join(''):'';
  const diagnostics=report.diagnostics ? `<h2>Processing blockers</h2><p>${escape(report.diagnostics.blockers.join('; ') || 'None')}</p><p>Next eligible search: ${escape(report.diagnostics.nextEligibleSearchAt || 'Blocked until resolved')}</p><pre>${escape(JSON.stringify(report.diagnostics.budgets,null,2))}</pre>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>COT pipeline report</title><style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 20px;color:#142033}p,li{line-height:1.6}.notice{background:#fff7df;border:1px solid #dec879;padding:16px;border-radius:8px}a{color:#124ac0}</style></head><body><h1>COT pipeline report</h1><p class="notice">${escape(report.message)}</p><p>Snapshot: ${escape(report.generatedAt||'unavailable')}</p>${diagnostics}${counts?`<h2>Saved lead counts</h2><ul>${counts}</ul><p>These counts include earlier runs. They are not the number of leads collected by this invocation.</p>`:''}${budgets?`<h2>Lifetime allowance for new work</h2><ul>${budgets}</ul><p>Exhausted allowances require an approved budget change. Do not delete storage or reset counters.</p>`:''}<p><a target="_blank" rel="noopener noreferrer" href="https://techies-validator-fro-git-679e6d-jehu-zachary-sedillos-projects.vercel.app">Open saved leads dashboard</a> (dashboard password required).</p><p>This report describes this invocation, not the current schedule switch. Opening it does not start work. Keep the schedule paused when processing is disabled to avoid idle charges.</p></body></html>`;
}

export async function publishReport(client,defaultStore,runId,report) {
  await defaultStore.setRecord({key:'OUTPUT',value:report});
  await defaultStore.setRecord({key:'REPORT.html',value:reportHtml(report),contentType:'text/html; charset=utf-8'});
  // Failure to decorate the Console must not replay a completed paid step.
  try {await client.run(runId).update({statusMessage:report.message,isStatusMessageTerminal:true});}
  catch {console.warn('CONSOLE_STATUS_UPDATE_FAILED: read OUTPUT or REPORT.html for the completed step.');}
}
