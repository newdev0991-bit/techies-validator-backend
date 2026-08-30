import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../../server.js';
import { Providers } from '../providers.mjs';
import { readFileSync } from 'node:fs';

test('real backend HTTP pipeline routes require secret and verified deployment before accepting a batch',async t=>{
  const keys=['COT_PIPELINE_API_KEY','COT_ACTOR_MAX_CHARGE_USD','COT_CONTACT_ACTOR_READY'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
  process.env.COT_PIPELINE_API_KEY='synthetic-test-key';process.env.COT_ACTOR_MAX_CHARGE_USD='0.20';delete process.env.COT_CONTACT_ACTOR_READY;
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:'Bearer synthetic-test-key','Content-Type':'application/json'};
  assert.equal((await fetch(`${url}/pipeline-capabilities`)).status,401);
  assert.equal((await fetch(`${url}/pipeline-capabilities`,{headers})).status,503);
  process.env.COT_CONTACT_ACTOR_READY='true';
  const result=await fetch(`${url}/pipeline-capabilities`,{headers});assert.equal(result.status,200);
  assert.equal((await result.json()).actorMaxChargeUsd,0.2);
  // Malformed payload is rejected before any Actor/model request.
  assert.equal((await fetch(`${url}/pipeline/validate-batch`,{method:'POST',headers,body:'{}'})).status,400);
  assert.equal((await fetch(`${url}/pipeline/validate-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
});

test('provider preflight uses auth, refuses old backend, and never starts an Actor',async()=>{
  const c=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url)));let count=0;
  const p=new Providers(c,{token:'search-test-key',validatorToken:'validator-test-key',fetchFn:async(url,options)=>{
    count++;assert.equal(options.method,'GET');
    if(url.endsWith('/pipeline-capabilities')){
      assert.equal(options.headers.Authorization,'Bearer validator-test-key');
      return Response.json({contactEnrichment:'cot-contact-enrichment-v1',batchContract:'cot-data-batch-v1',maxBatchSize:3,actorMaxChargeUsd:0.2});
    }
    assert.equal(options.headers.Authorization,'Bearer search-test-key');return Response.json({data:{id:c.actorId}});
  }});
  await p.preflight();assert.equal(count,2);
  p.fetch=async()=>Response.json({ok:true});await assert.rejects(()=>p.preflight(),{code:'VALIDATOR_NOT_READY'});
});
