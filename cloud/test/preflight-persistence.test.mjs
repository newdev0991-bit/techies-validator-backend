import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../pipeline/store.mjs';
import {Runner} from '../../pipeline/runner.mjs';
import {ProviderError} from '../../pipeline/providers.mjs';
import {CloudState} from '../state.mjs';
import {controllerOperation} from '../operations.mjs';
const base=JSON.parse(readFileSync(new URL('../../pipeline/config.canary.example.json',import.meta.url)));
const now=Date.parse('2026-09-03T12:00:00Z');
const lease={async assert(){}};
function kvFixture(){const records=new Map();return {records,async getRecord(key){return records.has(key)?{value:structuredClone(records.get(key))}:undefined;},async setRecord({key,value}){records.set(key,structuredClone(value));}};}
function local(t){const dir=mkdtempSync(path.join(os.tmpdir(),'cot-persistence-'));const s=new Store(dir);t.after(()=>s.close());return {s,dir};}
async function restore(t,kv){const f=local(t);const cloud=new CloudState(kv,lease);f.s.restore(await cloud.load());f.s.flush=()=>cloud.save(f.s.snapshot());return f;}
function seed(s){
  for(let i=0;i<77;i++)s.insert('synthetic-'+i,'historical',{synthetic:true},{'Company Name':'Synthetic '+i},now);
  for(let i=0;i<12;i++)s.charge('2026-09-03','searches');
  for(let i=0;i<28;i++)s.charge('2026-09-03','validations');
  s.set('halted',{code:'PROVIDER_CONNECTION_UNCERTAIN',at:now});s.set('cycle',null);s.set('batch',null);
  s.set('incompleteSearches',1);s.set('queryIndex',2);s.set('nextSearchAt',now+3600000);
}
const noPaid={async tick(){throw Error('Paid runner must not execute during recovery');}};

test('readiness retry and reservation survive actual cloud chunk serialization into fresh stores',async t=>{
  const kv=kvFixture(),first=local(t);let clock=now,checks=0,starts=0;
  const cloud=new CloudState(kv,lease);first.s.flush=()=>cloud.save(first.s.snapshot());
  const providers={async preflight(){checks++;if(checks===1)throw new ProviderError('PROVIDER_CONNECTION_UNCERTAIN');},async start(){starts++;return {id:'synthetic-run',actId:base.actorId};}};
  const config={...base,enabled:true,outputDir:path.join(first.dir,'out')};
  assert.equal((await new Runner(config,first.s,providers,{now:()=>clock}).tick()).status,'preflight_retry');
  const next=await restore(t,kv);const runner=new Runner({...config,outputDir:path.join(next.dir,'out')},next.s,providers,{now:()=>clock});
  assert.equal((await runner.tick()).status,'preflight_backoff');assert.equal(checks,1);assert.equal(starts,0);
  clock+=60000;assert.equal((await runner.tick()).status,'search_started');
  const final=await restore(t,kv);assert.equal(final.s.get('preflightRetry'),null);
  assert.equal(final.s.get('cycle').runId,'synthetic-run');assert.equal(final.s.totals().searches,1);assert.equal(starts,1);
});

test('cloud recovery persists cleared halt and preserves 77 synthetic leads and 12/28 usage across containers',async t=>{
  const kv=kvFixture(),first=local(t);seed(first.s);await new CloudState(kv,lease).save(first.s.snapshot());
  const before=first.s.snapshot(),maintenance=await restore(t,kv);let checks=0;
  const p={async preflight(){checks++;}};const config={...base,enabled:true};
  const manifest=structuredClone(kv.records.get('STATE'));
  const plan=await controllerOperation({operation:'preflight-recovery-plan',enabled:false},config,maintenance.s,p,noPaid);
  assert.equal(plan.eligible,true);assert.deepEqual(kv.records.get('STATE'),manifest);
  assert.equal((await controllerOperation({operation:'recover-preflight',enabled:false},config,maintenance.s,p,noPaid)).status,'recovered');
  const final=await restore(t,kv);assert.equal(final.s.get('halted'),null);assert.equal(final.s.count(),77);assert.equal(checks,2);
  assert.deepEqual({...final.s.totals()},{searches:12,validations:28});
  for(const table of ['leads','quarantine','runs','daily'])assert.deepEqual(final.s.snapshot()[table],before[table]);
  for(const key of ['incompleteSearches','queryIndex','nextSearchAt','cycle','batch'])assert.deepEqual(final.s.get(key),first.s.get(key));
});

test('failed recovery manifest commit leaves the original halted cloud state authoritative',async t=>{
  const kv=kvFixture(),first=local(t);seed(first.s);await new CloudState(kv,lease).save(first.s.snapshot());
  const before=first.s.snapshot(),maintenance=await restore(t,kv),put=kv.setRecord.bind(kv);
  kv.setRecord=async record=>{if(record.key==='STATE')throw Error('synthetic commit failure');await put(record);};
  await assert.rejects(()=>controllerOperation({operation:'recover-preflight',enabled:false},base,maintenance.s,{async preflight(){}},noPaid),/commit failure/);
  const final=await restore(t,kv);assert.deepEqual(final.s.snapshot(),before);
});

test('lost lease during recovery cannot publish a cleared halt or invoke paid work',async t=>{
  const kv=kvFixture(),first=local(t);seed(first.s);await new CloudState(kv,lease).save(first.s.snapshot());
  const before=first.s.snapshot(),maintenance=await restore(t,kv);
  const lost=new CloudState(kv,{async assert(){throw Error('CLOUD_LOCK_LOST');}});
  maintenance.s.flush=()=>lost.save(maintenance.s.snapshot());
  await assert.rejects(()=>controllerOperation({operation:'recover-preflight',enabled:false},base,maintenance.s,{async preflight(){}},noPaid),/CLOUD_LOCK_LOST/);
  const final=await restore(t,kv);assert.deepEqual(final.s.snapshot(),before);
});

