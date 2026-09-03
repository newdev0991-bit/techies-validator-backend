import { randomUUID } from 'node:crypto';
import { searchLead, qualifySearchPost, validateResponse, assess } from './records.mjs';
import { exportFiles } from './exports.mjs';
import { searchOutcome } from './search-outcome.mjs';
import { transientPreflightError } from './providers.mjs';

const TERMINAL = new Set(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT']);
const RETRYABLE = new Set(['actor_partial_batch','actor_row_failure','apify_unavailable']);
const safeCode = error => /^[A-Z_a-z0-9-]{1,100}$/.test(error?.code || '') ? error.code : 'PIPELINE_OPERATION_FAILED';

export class Runner {
  constructor(config, store, providers, { now = Date.now } = {}) { this.c=config; this.s=store; this.p=providers; this.now=now; }
  halt(code) { this.s.set('halted', { code, at: this.now() }); return { status: 'halted', code }; }
  async checkPreflight() {
    const retry=this.s.get('preflightRetry');
    if (retry && this.now()<retry.nextAttemptAt) return {status:'preflight_backoff',...retry};
    try { await this.p.preflight(); }
    catch (error) {
      const code=safeCode(error);
      if (!transientPreflightError(error)) return this.halt(code);
      const attempts=(retry?.attempts || 0)+1;
      const next={code,attempts,nextAttemptAt:this.now()+60000*attempts};
      this.s.set('preflightRetry',next);
      if (attempts>=3) return this.halt('PREFLIGHT_RETRIES_EXHAUSTED');
      return {status:'preflight_retry',...next};
    }
    if (retry) this.s.set('preflightRetry',null);
    return null;
  }
  async tick() {
    if (!this.s.acquire()) return { status: 'busy' };
    try {
      const result = await this.work();
      this.s.set('lastTick', { ...result, at: this.now() });
      await this.s.flush?.();
      await exportFiles(this.s, this.c.outputDir, this.now());
      return result;
    } finally { this.s.release(); }
  }
  async work() {
    const c=this.c, s=this.s, now=this.now(), day=new Date(now).toISOString().slice(0,10);
    if (!c.enabled) return { status: 'disabled' };
    let cycle=s.get('cycle');
    const halt=s.get('halted');
    // A verified explicit import may finish validation while automatic search
    // remains halted. It cannot start a search or clear the search failure history.
    if (halt && !(halt.code==='REPEATED_INCOMPLETE_SEARCHES' && cycle?.origin==='standalone_import'
      && ['ingesting','validating'].includes(cycle.phase))) return { status: 'halted', ...halt };
    if (cycle?.phase === 'starting') return this.halt('SEARCH_START_UNCERTAIN');
    const batch=s.get('batch');
    if (batch?.phase === 'sending') return this.halt('VALIDATION_RESULT_UNCERTAIN');
    if (batch) return this.validateBatch(batch, day);
    if (cycle?.phase === 'searching') {
      let run;
      try { run=await this.p.run(cycle.runId); }
      catch (e) { return { status: 'poll_retry', code: safeCode(e) }; }
      if (run?.id !== cycle.runId || run.actId !== c.actorId) return this.halt('ACTOR_RUN_MISMATCH');
      if (!TERMINAL.has(run.status)) return { status: 'search_running', runId: cycle.runId };
      cycle={...cycle, phase:'ingesting', runStatus:run.status, datasetId:run.defaultDatasetId,
        kvId:run.defaultKeyValueStoreId, usageTotalUsd:run.usageTotalUsd ?? null, offset:0};
      if (!cycle.datasetId) return this.halt('DATASET_MISSING');
      s.set('cycle',cycle);
    }
    if (cycle?.phase === 'ingesting') return this.ingest(cycle);
    const pending=s.pending(c.validationBatchSize);
    if (pending.length) {
      if (s.daily(day).validations >= c.maxValidationCallsPerDay) return {status:'daily_validation_limit'};
      const id=`pipeline:${randomUUID()}`;
      const next={ id, phase:'ready', attempts:0, ids:pending.map(r=>r.id), payload:{ batchId:id,
        leads:pending.map((r,i)=>({ clientRowId:`${id}:${i}`, rowIndex:i, lead:JSON.parse(r.lead) })) } };
      s.set('batch',next); return this.validateBatch(next,day);
    }
    if (cycle?.phase === 'validating') {
      cycle={...cycle, phase:'complete', completedAt:now}; s.auditRun(cycle);
      const outcome=searchOutcome(cycle);
      if(cycle.origin==='standalone_import') {
        s.transaction(()=>{s.set('cycle',null);s.set('nextSearchAt',Math.max(s.get('nextSearchAt',0),now+c.searchIntervalSeconds*1000));});
        return {status:'cycle_complete',runId:cycle.runId,searchOutcome:outcome};
      }
      const failures=outcome === 'failed' ? s.get('incompleteSearches',0)+1 : 0;
      s.transaction(()=>{ s.set('cycle',null); s.set('nextSearchAt',now+c.searchIntervalSeconds*1000); s.set('incompleteSearches',failures); });
      if(failures>=3) return this.halt('REPEATED_INCOMPLETE_SEARCHES');
      return {status:'cycle_complete',runId:cycle.runId,searchOutcome:outcome};
    }
    if (now < s.get('nextSearchAt',0)) return {status:'waiting'};
    if (c.maxSearchRunsTotal && s.totals().searches >= c.maxSearchRunsTotal) return {status:'total_search_limit'};
    if (c.maxValidationCallsTotal && s.totals().validations >= c.maxValidationCallsTotal) return {status:'total_validation_limit'};
    if (s.daily(day).searches >= c.maxSearchRunsPerDay) return {status:'daily_search_limit'};
    if (s.daily(day).validations >= c.maxValidationCallsPerDay) return {status:'daily_validation_limit'};
    if (s.count() >= c.maxStoredLeads) return this.halt('STORAGE_LEAD_LIMIT');
    const readiness=await this.checkPreflight();
    if (readiness) return readiness;
    const queryIndex=s.get('queryIndex',0) % c.queries.length;
    cycle={id:randomUUID(),phase:'starting',createdAt:now,input:{...c.searchInput,query:c.queries[queryIndex]},queryIndex};
    // Commit BEFORE the paid POST. If its outcome is lost, pause for reconciliation.
    s.transaction(()=>{s.charge(day,'searches');s.set('cycle',cycle);s.set('queryIndex',queryIndex+1);});
    await s.flush?.(); // Cloud checkpoint must settle before any billed side effect.
    try {
      const run=await this.p.start(cycle.input);
      if (!run?.id || run.actId !== c.actorId) return this.halt('SEARCH_START_UNCERTAIN');
      s.set('cycle',{...cycle,phase:'searching',runId:run.id});
      return {status:'search_started',runId:run.id};
    } catch { return this.halt('SEARCH_START_UNCERTAIN'); }
  }
  async ingest(cycle) {
    let meta, summary, items;
    try {
      meta=await this.p.dataset(cycle.datasetId);
      if (cycle.total === undefined) {
        summary=await this.p.summary(cycle.kvId);
        if (!Number.isSafeInteger(meta?.itemCount) || meta.itemCount < 0 || meta.itemCount > this.c.maxDatasetItems) return this.halt('DATASET_SIZE_LIMIT');
        cycle={...cycle,total:meta.itemCount,summary,
          searchComplete:cycle.runStatus==='SUCCEEDED' && summary?.success===true && summary?.partial===false};
        this.s.set('cycle',cycle); this.s.auditRun(cycle);
      }
      if (meta?.itemCount !== cycle.total) return this.halt('DATASET_CHANGED_AFTER_COMPLETION');
      const limit=Math.min(100,cycle.total-cycle.offset);
      items=limit ? await this.p.items(cycle.datasetId,cycle.offset,limit) : [];
      if (!Array.isArray(items) || items.length!==limit) return this.halt('DATASET_PAGE_INCOMPLETE');
    } catch (e) { return {status:'dataset_retry',code:safeCode(e)}; }
    const existing=this.s.db.prepare('SELECT 1 FROM leads WHERE id=?');
    const newIds=new Set(items.filter(post=>qualifySearchPost(post).qualified
      && typeof post?.post_id==='string' && !existing.get(post.post_id)).map(post=>post.post_id));
    if (this.s.count()+newIds.size > this.c.maxStoredLeads) return this.halt('STORAGE_LEAD_LIMIT');
    this.s.transaction(()=>{
      items.forEach((post,index)=>{
        const qualification=qualifySearchPost(post);
        if(!qualification.qualified) {
          this.s.db.prepare('INSERT OR IGNORE INTO quarantine VALUES(?,?,?,?)').run(
            `${cycle.runId}:${cycle.offset+index}`,cycle.runId,JSON.stringify(post),`LOW_INTENT_SEARCH_RESULT:${qualification.reason}`);
          return;
        }
        try {
          const lead=searchLead(post);
          if(post.query && post.query!==cycle.input.query) throw new Error('QUERY_MISMATCH');
          const inserted = this.s.insert(post.post_id,cycle.runId,post,lead,this.now());
          cycle.metrics ||= { filtered: 0, duplicates: 0, retained: 0 };
          cycle.metrics[inserted ? 'retained' : 'duplicates']++;
        } catch {
          cycle.metrics ||= { filtered: 0, duplicates: 0, retained: 0 };
          cycle.metrics.invalid=(cycle.metrics.invalid || 0)+1;
          this.s.db.prepare('INSERT OR IGNORE INTO quarantine VALUES(?,?,?,?)').run(
            `${cycle.runId}:${cycle.offset+index}`,cycle.runId,JSON.stringify(post),'INVALID_SEARCH_ROW');
        }
      });
      cycle.metrics ||= { filtered: 0, duplicates: 0, retained: 0 };
      cycle.metrics.filtered += items.filter(post => !qualifySearchPost(post).qualified).length;
      cycle={...cycle,offset:cycle.offset+items.length};
      if (cycle.offset===cycle.total) cycle.phase='validating';
      this.s.set('cycle',cycle); this.s.auditRun(cycle);
    });
    if(cycle.metrics.invalid) return this.halt('INVALID_SEARCH_DATASET');
    return {status:cycle.phase==='validating'?'search_ingested':'ingesting',searchComplete:cycle.searchComplete,total:cycle.total};
  }
  async validateBatch(batch, day) {
    const s=this.s,c=this.c;
    if (c.maxValidationCallsTotal && s.totals().validations>=c.maxValidationCallsTotal) return {status:'total_validation_limit'};
    if (this.now()<(batch.nextAttemptAt||0)) return {status:'validation_backoff'};
    if (s.daily(day).validations>=c.maxValidationCallsPerDay) return {status:'daily_validation_limit'};
    const readiness=await this.checkPreflight();
    if (readiness) return readiness;
    batch={...batch,phase:'sending',attempts:batch.attempts+1};
    s.transaction(()=>{s.charge(day,'validations');s.set('batch',batch);});
    await s.flush?.();
    let response;
    try { response=await this.p.validate(batch.payload); }
    catch (e) {
      if (e.status===503 && RETRYABLE.has(e.code) && batch.attempts<c.maxValidationAttempts) {
        s.set('batch',{...batch,phase:'ready',nextAttemptAt:this.now()+60000*batch.attempts});
        return {status:'validation_retry',code:e.code};
      }
      // Includes connection loss, timeout, malformed responses and crash recovery.
      // The backend's replay cache is memory-only; never promise exactly-once paid work.
      return this.halt('VALIDATION_RESULT_UNCERTAIN');
    }
    let results;
    try { results=validateResponse(response,batch.payload).map(row=>assess(row,this.now())); }
    catch { return this.halt('VALIDATION_CONTRACT_MISMATCH'); }
    s.transaction(()=>{results.forEach((r,i)=>s.complete(batch.ids[i],r));s.set('batch',null);});
    return {status:'validated',count:results.length};
  }
}
