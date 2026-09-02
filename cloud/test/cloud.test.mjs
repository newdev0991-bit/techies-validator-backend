import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../pipeline/store.mjs';
import {Runner} from '../../pipeline/runner.mjs';
import {CloudState,CloudLease} from '../state.mjs';
import {resultSnapshot} from '../results.mjs';
import {keywordMetrics,pipelineDiagnostics} from '../diagnostics.mjs';
import {readSnapshot,migrationPlan,initializeStorage,scheduleDefinition} from '../setup.mjs';

const base=JSON.parse(readFileSync(new URL('../../pipeline/config.canary.example.json',import.meta.url)));
function store(t){const dir=mkdtempSync(path.join(os.tmpdir(),'cot-cloud-test-'));const s=new Store(dir);t.after(()=>s.close());return {s,dir};}
function remote(){const records=new Map();return {records,async getRecord(k){return records.has(k)?{value:structuredClone(records.get(k))}:undefined;},async setRecord({key,value}){records.set(key,structuredClone(value));}};}
const lease={async assert(){}};

test('keyword aggregates preserve historical yield and unknown costs; all blockers stay visible',t=>{
  const row={query:'our new premises',raw:3,filtered:1,duplicates:0,retained:2,validated:2,readyAtValidation:1,unresolvedContacts:1,knownSearchCostUsd:0.01};
  const [group]=keywordMetrics([row,{...row,knownSearchCostUsd:null,duplicates:null}]);
  assert.equal(group.cycles,2);assert.equal(group.readyAtValidation,2);assert.equal(group.validated,4);
  assert.equal(group.smallSample,true);assert.equal(group.knownSearchCostUsd,null);assert.equal(group.duplicates,null);
  const {s}=store(t);for(let i=0;i<8;i++)s.charge('2026-09-03','searches');
  s.set('halted',{code:'REPEATED_INCOMPLETE_SEARCHES'});
  const diagnostics=pipelineDiagnostics(s,{maxSearchRunsTotal:8,maxSearchRunsPerDay:3},
    {blockers:['Input Allow processing is off','CONFIG.enabled is not true']},Date.parse('2026-09-03T12:00:00Z'));
  assert.equal(diagnostics.blockers.length,5);assert.equal(diagnostics.budgets.searches.remaining,0);
  assert.equal(diagnostics.nextEligibleSearchAt,null);
});

test('cloud checkpoints preserve dedup, counters, pending work and resume identity across new containers',async t=>{
  const {s}=store(t);s.insert('123','run','synthetic',{ 'Company Name':'Synthetic'},100);s.charge('2026-08-30','searches');s.set('cycle',{phase:'searching',runId:'same-run'});
  const kv=remote();await new CloudState(kv,lease).save(s.snapshot());
  const restored=store(t).s;restored.restore(await new CloudState(kv,lease).load());
  assert.equal(restored.insert('123','other','synthetic',{},200),0);
  assert.equal(restored.totals().searches,1);assert.equal(restored.get('cycle').runId,'same-run');
  assert.equal(restored.acquire(),true);restored.release(); // no stale local PID lock was migrated
});

test('failed checkpoint commit leaves the previous authoritative snapshot and corrupt chunks are rejected',async t=>{
  const {s}=store(t),kv=remote(),state=new CloudState(kv,lease);
  s.set('counter',1);await state.save(s.snapshot());
  const put=kv.setRecord.bind(kv);kv.setRecord=async r=>{if(r.key==='STATE')throw new Error('lost write');return put(r);};
  s.set('counter',2);await assert.rejects(()=>state.save(s.snapshot()));
  const restored=store(t).s;restored.restore(await new CloudState(kv,lease).load());assert.equal(restored.get('counter'),1);
  const manifest=kv.records.get('STATE');kv.records.set(manifest.tables.meta[0],[{key:'counter',value:'99'}]);
  await assert.rejects(()=>new CloudState(kv,lease).load(),/CORRUPT/);
});

test('no paid search starts until its reserved counter and intent reach cloud storage',async t=>{
  const {s,dir}=store(t),config={...base,enabled:true,outputDir:path.join(dir,'out')};let starts=0;
  s.flush=async()=>{throw new Error('checkpoint unavailable');};
  const p={async preflight(){},async start(){starts++;}};
  await assert.rejects(()=>new Runner(config,s,p).tick(),/checkpoint unavailable/);assert.equal(starts,0);
});

test('a crash after paid start cannot repeat that search in the next container',async t=>{
  const first=store(t),kv=remote(),state=new CloudState(kv,lease);let flushes=0,starts=0;
  first.s.flush=async()=>{if(++flushes>1)throw new Error('crash after start');await state.save(first.s.snapshot());};
  const p={async preflight(){},async start(){starts++;return {id:'run123',actId:base.actorId};}};
  await assert.rejects(()=>new Runner({...base,enabled:true,outputDir:path.join(first.dir,'out')},first.s,p).tick());
  const next=store(t);next.s.restore(await new CloudState(kv,lease).load());
  const r=await new Runner({...base,enabled:true,outputDir:path.join(next.dir,'out')},next.s,p).tick();
  assert.equal(r.code,'SEARCH_START_UNCERTAIN');assert.equal(starts,1);assert.equal(next.s.totals().searches,1);
});

test('a pending validation is checkpointed before submission and cannot silently retry after restart',async t=>{
  const first=store(t),kv=remote(),state=new CloudState(kv,lease);let calls=0;
  first.s.insert('123','run',{}, {'Company Name':'Synthetic'},1);
  first.s.flush=()=>state.save(first.s.snapshot());
  const p={async preflight(){},async validate(){calls++;throw new Error('response lost');}};
  const r=await new Runner({...base,enabled:true,outputDir:path.join(first.dir,'out')},first.s,p).tick();
  assert.equal(r.code,'VALIDATION_RESULT_UNCERTAIN');
  const next=store(t);next.s.restore(await new CloudState(kv,lease).load());
  assert.equal((await new Runner({...base,enabled:true,outputDir:path.join(next.dir,'out')},next.s,p).tick()).status,'halted');
  assert.equal(calls,1);assert.equal(next.s.totals().validations,1);
});

test('queue leases reject concurrent owners and expired ownership',async()=>{
  let held=false,clock=1000;
  const queue={async addRequest(){return {requestId:'lock'};},async listAndLockHead(){if(held)return {items:[]};held=true;return {items:[{id:'lock'}]};},
    async prolongRequestLock(){},async deleteRequestLock(){held=false;}};
  const a=new CloudLease(queue,{now:()=>clock}),b=new CloudLease(queue,{now:()=>clock});
  try{assert.equal(await a.acquire(),true);assert.equal(await b.acquire(),false);await a.assert();
    clock+=300001;await assert.rejects(()=>a.assert(),/LOCK_LOST/);await assert.rejects(()=>a.renew(),/LOCK_LOST/);
  }finally{await a.release();await b.release();}
});

test('dashboard snapshots contain only selected fields, never raw source or credentials',t=>{
  const {s}=store(t);s.insert('123','run',{privateRaw:'do not expose'},{'Company Name':'Synthetic','Lead Proof URL':'https://facebook.com/example'},1);
  const view=resultSnapshot(s,Date.now(),false);
  assert.equal(view.rows[0].status,'PENDING');assert.equal(JSON.stringify(view).includes('privateRaw'),false);
  assert.equal(view.enabled,false);
});

test('migration preserves the source database and counters, and refuses a second initialization',async t=>{
  const {s,dir}=store(t);s.insert('123','run',{}, {'Company Name':'Synthetic'},1);s.charge('2026-08-30','validations');
  const original=s.snapshot(),snapshot=readSnapshot(path.join(dir,'pipeline.sqlite'));
  assert.deepEqual(snapshot,original);
  const kv=remote();await initializeStorage(kv,lease,snapshot,{...base,enabled:true});
  assert.equal(kv.records.get('CONFIG').enabled,false);
  assert.equal(kv.records.get('RESULTS').totals.validations,1);
  assert.deepEqual(s.snapshot(),original);
  const restored=await new CloudState(kv,lease).load();
  assert.equal(migrationPlan(restored).sourceHash,migrationPlan(snapshot).sourceHash);
  await assert.rejects(()=>initializeStorage(kv,lease,snapshot,base),/NOT_EMPTY/);
  kv.records.delete('STATE'); // missing state must never reset the paid counters
  await assert.rejects(()=>initializeStorage(kv,lease,snapshot,base),/NOT_EMPTY/);
});

test('the prepared schedule is disabled, exclusive and bounded',()=>{
  const schedule=scheduleDefinition('controller-id','state-store','lock-queue');
  assert.equal(schedule.isEnabled,false);assert.equal(schedule.isExclusive,true);
  assert.equal(schedule.actions[0].actorId,'controller-id');
  assert.equal(schedule.actions[0].runOptions.restartOnError,false);
  assert.equal(schedule.actions[0].runOptions.timeoutSecs,900);
  assert.deepEqual(JSON.parse(schedule.actions[0].runInput.body),{enabled:true,stateStoreId:'state-store',lockQueueId:'lock-queue'});
});

test('a slow lock response never extends ownership past its conservative deadline',async()=>{
  let now=0;
  const queue={async addRequest(){return {requestId:'lock'};},async listAndLockHead(){now=310000;return {items:[{id:'lock'}]};}};
  await assert.rejects(()=>new CloudLease(queue,{now:()=>now}).acquire(),/LOCK_LOST/);
});
