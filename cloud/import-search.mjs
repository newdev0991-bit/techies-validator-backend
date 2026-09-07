import { isDeepStrictEqual } from 'node:util';
import { searchLead } from '../pipeline/records.mjs';
import { incompleteSearchDelaySeconds } from '../pipeline/search-outcome.mjs';

// Import existing output only. Normal controller ticks own all paid validation.
export async function importSearch(input,c,s,p,runner) {
  if(input.enabled===true) throw new Error('IMPORT_REQUIRES_PROCESSING_OFF');
  const runId=input.searchRunId;
  if(!/^[A-Za-z0-9]{1,100}$/.test(runId||'')) throw new Error('INVALID_SEARCH_RUN_ID');
  if(!s.acquire()) throw new Error('Worker is busy');
  try {
    const recorded=s.db.prepare('SELECT record FROM runs').all().map(r=>JSON.parse(r.record));
    if(recorded.some(r=>r.runId===runId)) return {status:'already_imported',runId};
    const previous=s.get('cycle'),halt=s.get('halted');
    // An empty, fully ingested terminal cycle has no outstanding provider work.
    // Finalize its audit on apply, never discard it or reset its failure count.
    const emptyFinished=previous?.phase==='validating' && previous.total===0 && previous.offset===0
      && ['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(previous.runStatus);
    if((previous && !emptyFinished) || s.get('batch') || s.pending(1).length
      || (halt && halt.code!=='REPEATED_INCOMPLETE_SEARCHES')) throw new Error('IMPORT_REQUIRES_IDLE_CONTROLLER');
    const run=await p.run(runId);
    if(run?.id!==runId || run.actId!==c.actorId || run.status!=='SUCCEEDED'
      || !run.defaultDatasetId || !run.defaultKeyValueStoreId || !Number.isFinite(Date.parse(run.startedAt))) throw new Error('IMPORT_RUN_MISMATCH');
    const source=await p.input(run.defaultKeyValueStoreId),summary=await p.summary(run.defaultKeyValueStoreId);
    const allowed=new Set([...Object.keys(c.searchInput),'query','googleFallbackBudgetMs','googleSearchTimeoutMs']);
    if(!source || Object.keys(source).some(k=>!allowed.has(k))) throw new Error('IMPORT_INPUT_MISMATCH');
    if(!c.queries.includes(source?.query) || Object.keys(c.searchInput).some(k=>!isDeepStrictEqual(source?.[k],c.searchInput[k]))) throw new Error('IMPORT_INPUT_MISMATCH');
    const meta=await p.dataset(run.defaultDatasetId);
    if(!Number.isSafeInteger(meta?.itemCount) || meta.itemCount<1 || meta.itemCount>c.maxDatasetItems
      || summary?.schemaVersion!=='facebook-search-run-v1' || summary.success!==true || summary.partial!==false
      || summary.query!==source.query || summary.resultCount!==meta.itemCount
      || summary.accountAuthenticationUsed!==false || summary.cookiesUsed!==false || summary.paidSearchApiUsed!==false
      || !['max_results','exhausted'].includes(summary.stoppingReason)) throw new Error('IMPORT_EVIDENCE_MISMATCH');
    const items=[];
    for(let offset=0;offset<meta.itemCount;offset+=100) {
      const limit=Math.min(100,meta.itemCount-offset),page=await p.items(run.defaultDatasetId,offset,limit);
      if(!Array.isArray(page) || page.length!==limit) throw new Error('IMPORT_DATASET_INCOMPLETE');
      for(const post of page) {
        searchLead(post);
        if(post.query!==source.query) throw new Error('IMPORT_QUERY_MISMATCH');
        items.push(post);
      }
    }
    const report={runId,total:items.length,finalizesEmptyCycle:emptyFinished?previous.runId:null,
      searchSubmitted:false,validationSubmitted:false};
    if(input.operation==='import-search-plan') return {status:'import_plan',...report};
    // Preserve query position and budget history. Account for the already-paid
    // external search exactly once, together with its durable import receipt.
    const cycle={id:`import:${runId}`,runId,origin:'standalone_import',createdAt:Date.parse(run.startedAt),
      phase:'ingesting',input:source,runStatus:run.status,datasetId:run.defaultDatasetId,
      kvId:run.defaultKeyValueStoreId,usageTotalUsd:run.usageTotalUsd??null,offset:0};
    s.transaction(()=>{
      if(emptyFinished) {
        s.auditRun({...previous,phase:'complete',completedAt:Date.now()});
        const failures=previous.searchComplete===true?0:s.get('incompleteSearches',0)+1;
        s.set('incompleteSearches',failures);
        s.set('nextSearchAt',Date.now()+(failures ? incompleteSearchDelaySeconds(failures,c.searchIntervalSeconds) : c.searchIntervalSeconds)*1000);
      }
      s.charge(run.startedAt.slice(0,10),'searches');s.set('cycle',cycle);s.auditRun(cycle);
    });
    await s.flush?.();
    const result=await runner.ingest(cycle);
    s.set('lastTick',{...result,runId,at:Date.now()});
    await s.flush?.();
    return {...result,...report};
  } finally {s.release();}
}
