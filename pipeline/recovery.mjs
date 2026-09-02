import { isDeepStrictEqual } from 'node:util';
import { searchOutcome } from './search-outcome.mjs';
import { searchLead } from './records.mjs';

export async function boundedRecoveryReport(s, c, p) {
  const blockers=[];
  if (s.get('halted')?.code !== 'REPEATED_INCOMPLETE_SEARCHES') blockers.push('HALT_NOT_ELIGIBLE');
  if (s.get('cycle') || s.get('batch')) blockers.push('WORK_IN_PROGRESS');
  const records=s.db.prepare('SELECT record FROM runs').all().map(x=>JSON.parse(x.record))
    .sort((a,b)=>(b.completedAt || b.createdAt || 0)-(a.completedAt || a.createdAt || 0));
  const count=s.get('incompleteSearches',0);
  const validCount=Number.isSafeInteger(count) && count>=3 && count<=records.length;
  const recent=validCount ? records.slice(0,count) : [];
  if (!validCount || new Set(recent.map(r=>r.runId)).size!==recent.length) blockers.push('INSUFFICIENT_RUN_EVIDENCE');
  const evidence=[];
  for (const r of recent) {
    try {
      if(!Number.isSafeInteger(r.total) || r.total<=0 || r.total>c.maxDatasetItems) throw new Error('INVALID_DATASET_SIZE');
      const live=await p.run(r.runId);
      if (live?.id !== r.runId || live.actId !== c.actorId || live.defaultDatasetId !== r.datasetId || live.defaultKeyValueStoreId !== r.kvId)
        throw new Error('RUN_MISMATCH');
      const input=await p.input(r.kvId), summary=await p.summary(r.kvId), dataset=await p.dataset(r.datasetId);
      if (Object.keys(r.input).some(k=>!isDeepStrictEqual(r.input[k],input?.[k])) || dataset?.itemCount !== r.total)
        throw new Error('EVIDENCE_MISMATCH');
      for(let offset=0;offset<r.total;offset+=100) {
        const size=Math.min(100,r.total-offset),items=await p.items(r.datasetId,offset,size);
        if(!Array.isArray(items) || items.length!==size) throw new Error('CORRUPT_DATASET');
        for(const post of items) {
          searchLead(post);
          if(post.query && post.query!==r.input.query) throw new Error('QUERY_MISMATCH');
        }
      }
      const outcome=searchOutcome({...r,summary,runStatus:live.status,searchComplete:false});
      if (outcome !== 'bounded_partial') blockers.push('RUN_NOT_BOUNDED_PARTIAL');
      evidence.push({runId:r.runId,outcome});
    } catch { blockers.push('RUN_VERIFICATION_FAILED'); evidence.push({runId:r.runId,outcome:'unverified'}); }
  }
  return {eligible:blockers.length===0,blockers:[...new Set(blockers)],evidence,totals:s.totals(),
    searchAllowanceRemaining:Math.max(0,(c.maxSearchRunsTotal || 0)-s.totals().searches)};
}

export async function recover(command,args,c,s,p) {
  if (!s.acquire()) throw new Error('Worker is busy');
  try {
    const cycle=s.get('cycle'), batch=s.get('batch');
    if (command==='recover-bounded-searches') {
      const report=await boundedRecoveryReport(s,c,p);
      if (!args.includes('--apply')) return {status:'recovery_plan',...report};
      if (!report.eligible || c.enabled) throw new Error('BOUNDED_RECOVERY_NOT_SAFE');
      s.transaction(()=>{s.set('halted',null);s.set('incompleteSearches',0);s.set('lastRecovery',{at:Date.now(),...report});});
      await s.flush?.();
      return {status:'recovered',...report};
    } else if (command==='attach-run') {
      if (cycle?.phase!=='starting' || !/^[A-Za-z0-9]+$/.test(args[0]||'')) throw new Error('No uncertain search to attach');
      const run=await p.run(args[0]);
      if (run?.id!==args[0] || run.actId!==c.actorId || !run.defaultKeyValueStoreId
          || !Number.isFinite(Date.parse(run.startedAt)) || Date.parse(run.startedAt)<cycle.createdAt-60000) throw new Error('Run mismatch');
      const input=await p.input(run.defaultKeyValueStoreId);
      if (Object.keys(cycle.input).some(k=>!isDeepStrictEqual(input?.[k],cycle.input[k]))) throw new Error('Input mismatch');
      s.transaction(()=>{s.set('cycle',{...cycle,phase:'searching',runId:run.id});s.set('halted',null);});
    } else if (command==='retry-batch') {
      if (!batch || batch.attempts>=c.maxValidationAttempts || !args.includes('--acknowledge-possible-charge')) throw new Error('Explicit charge acknowledgement and remaining attempts required');
      s.transaction(()=>{s.set('batch',{...batch,phase:'ready',nextAttemptAt:0});s.set('halted',null);});
    } else if (command==='resume') {
      if (cycle?.phase==='starting' || batch?.phase==='sending') throw new Error('Reconcile uncertain paid operation first');
      if (s.get('halted')?.code==='REPEATED_INCOMPLETE_SEARCHES') throw new Error('USE_VERIFIED_BOUNDED_RECOVERY');
      s.transaction(()=>{s.set('halted',null);s.set('incompleteSearches',0);});
    } else throw new Error('UNKNOWN_RECOVERY_COMMAND');
    return {status:'recovered',command};
  } finally {s.release();}
}
