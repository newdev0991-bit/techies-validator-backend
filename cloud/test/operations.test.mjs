import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../pipeline/store.mjs';
import {controllerOperation} from '../operations.mjs';

test('cloud recovery is disabled, verified, durable and cannot call the paid runner',async t=>{
  const s=new Store(mkdtempSync(path.join(os.tmpdir(),'cot-recovery-')));t.after(()=>s.close());
  s.set('halted',{code:'PROVIDER_CONNECTION_UNCERTAIN'});s.set('incompleteSearches',1);
  let checks=0,flushes=0;s.flush=async()=>{flushes++;};
  const p={async preflight(){checks++;}},runner={async tick(){throw Error('Paid runner called');}};
  const config={enabled:true};const input={enabled:false,operation:'preflight-recovery-plan'};
  assert.equal((await controllerOperation(input,config,s,p,runner)).eligible,true);assert.ok(s.get('halted'));
  await assert.rejects(()=>controllerOperation({...input,enabled:true},config,s,p,runner),/PROCESSING_OFF/);
  assert.equal((await controllerOperation({...input,operation:'recover-preflight'},config,s,p,runner)).status,'recovered');
  assert.equal(checks,2);assert.equal(flushes,1);assert.equal(s.get('halted'),null);assert.equal(s.get('incompleteSearches'),1);
  assert.deepEqual({...s.totals()},{searches:0,validations:0});
});

test('cloud dispatch preserves tick and bounded recovery operations and rejects unknown names',async t=>{
  const s=new Store(mkdtempSync(path.join(os.tmpdir(),'cot-recovery-')));t.after(()=>s.close());
  let ticks=0;const runner={async tick(){ticks++;return {status:'disabled'};}};
  assert.equal((await controllerOperation({}, {},s,{},runner)).status,'disabled');assert.equal(ticks,1);
  assert.equal((await controllerOperation({operation:'recovery-plan'}, {},s,{},runner)).status,'recovery_plan');
  await assert.rejects(()=>controllerOperation({operation:'recover-bounded-searches',enabled:true},{},s,{},runner),/PROCESSING_OFF/);
  for(const operation of ['unknown','__proto__','constructor'])
    await assert.rejects(()=>controllerOperation({operation},{},s,{},runner),/INVALID_OPERATION/);
  const schema=JSON.parse(readFileSync(new URL('../../.actor/input_schema.json',import.meta.url)));
  for(const operation of ['tick','recovery-plan','recover-bounded-searches','preflight-recovery-plan','recover-preflight'])
    assert.ok(schema.properties.operation.enum.includes(operation));
});
