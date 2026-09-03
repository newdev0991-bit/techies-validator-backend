import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../pipeline/store.mjs';
import {Runner} from '../../pipeline/runner.mjs';
import {controllerOperation} from '../operations.mjs';

function fixture(t) {
  const c=JSON.parse(readFileSync(new URL('../../pipeline/config.canary.example.json',import.meta.url)));
  const s=new Store(mkdtempSync(path.join(os.tmpdir(),'cot-import-')));t.after(()=>s.close());
  s.set('queryIndex',2);s.set('nextSearchAt',99999);
  const source={...c.searchInput,query:c.queries[0]};
  const post={schemaVersion:'facebook-search-posts-v2',query:source.query,post_id:'12345',
    url:'https://www.facebook.com/example/posts/12345',author:{name:'Example'},
    message:'We are opening our new premises.',posted_at:'2026-09-03T11:00:00Z'};
  const run={id:'external1',actId:c.actorId,status:'SUCCEEDED',startedAt:'2026-09-03T12:00:00Z',defaultDatasetId:'data1',defaultKeyValueStoreId:'kv1'};
  const summary={schemaVersion:'facebook-search-run-v1',success:true,partial:false,query:source.query,resultCount:1,
    stoppingReason:'max_results',accountAuthenticationUsed:false,cookiesUsed:false,paidSearchApiUsed:false};
  const p={run:async()=>run,input:async()=>source,summary:async()=>summary,dataset:async()=>({itemCount:1}),items:async()=>[post],
    start:async()=>{throw Error('Must not submit search');},validate:async()=>{throw Error('Must not submit validation');}};
  let durable;s.flush=async()=>{durable=s.snapshot();};
  const runner=new Runner(c,s,p);const input={operation:'import-search-run',enabled:false,searchRunId:run.id};
  return {c,s,p,runner,input,source,summary,run,post,durable:()=>durable};
}
test('standalone import plans without mutation and durably queues a deduplicated pending lead once',async t=>{
  const f=fixture(t),before=f.s.snapshot();
  const plan=await controllerOperation({...f.input,operation:'import-search-plan'},f.c,f.s,f.p,f.runner);
  assert.equal(plan.status,'import_plan');assert.deepEqual(f.s.snapshot(),before);
  const result=await controllerOperation(f.input,f.c,f.s,f.p,f.runner);
  assert.equal(result.status,'search_ingested');assert.equal(f.s.pending(3).length,1);
  assert.equal(f.s.rows()[0].status,'pending');assert.equal(f.s.get('cycle').phase,'validating');
  assert.equal(f.s.get('queryIndex'),2);assert.equal(f.s.get('nextSearchAt'),99999);
  assert.equal(f.s.totals().searches,1);assert.equal(f.s.totals().validations,0);
  assert.deepEqual(f.durable(),f.s.snapshot());
  assert.equal((await controllerOperation(f.input,f.c,f.s,f.p,f.runner)).status,'already_imported');
  assert.equal(f.s.totals().searches,1);
});
test('import refuses active work, activation, mismatched evidence and unsafe input without mutation',async t=>{
  for(const mutate of [f=>{f.input.enabled=true;},f=>f.s.set('cycle',{phase:'starting'}),
    f=>f.s.set('halted',{code:'VALIDATION_RESULT_UNCERTAIN'}),f=>{f.run.actId='other';},
    f=>{f.run.status='FAILED';},f=>{f.source.maxPages++;},f=>{f.source.requestContract={};},
    f=>{f.summary.resultCount=2;},f=>{f.summary.cookiesUsed=true;},f=>{f.post.query='other';}]) {
    const f=fixture(t);mutate(f);const before=f.s.snapshot();
    await assert.rejects(()=>controllerOperation(f.input,f.c,f.s,f.p,f.runner));
    assert.deepEqual(f.s.snapshot(),before);
  }
});
test('import receipt survives checkpoint failure without repeating the search counter',async t=>{
  const f=fixture(t);f.s.flush=async()=>{throw Error('checkpoint failed');};
  await assert.rejects(()=>controllerOperation(f.input,f.c,f.s,f.p,f.runner),/checkpoint failed/);
  assert.equal(f.s.get('cycle').phase,'ingesting');assert.equal(f.s.totals().searches,1);
  assert.equal((await controllerOperation(f.input,f.c,f.s,f.p,f.runner)).status,'already_imported');
});
