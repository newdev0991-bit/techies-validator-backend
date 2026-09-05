import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';
import { searchLead, assess } from '../records.mjs';
import { deliveryConfig, deliveryPlan, deliverReady, VIEWER_HEADERS } from '../delivery.mjs';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const config = deliveryConfig({TECHIES_DELIVERY_SOURCE:'MFULL',TECHIES_DELIVERY_BASE_URL:'https://destination.example',
  TECHIES_DELIVERY_TOKEN:'test-only',TECHIES_DELIVERY_ENABLED:'true',TECHIES_DELIVERY_QUEUE_REVIEWED:'true'});
function fixture(t, mutate = () => {}) {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(),'cot-delivery-')));
  t.after(()=>store.close());
  const lead = searchLead({schemaVersion:'facebook-search-posts-v2',post_id:'9007199254740993123',
    url:'https://www.facebook.com/example/posts/9007199254740993123',author:{name:'Synthetic Example'},
    message:'We are opening our new premises.',posted_at:'2026-09-05T11:00:00Z'});
  const raw = { inputUrl:lead['Lead Proof URL'],postUrl:lead['Lead Proof URL'],status:'success',scrape:{success:true},
    business:{identityStatus:'matched'},postText:lead['Lead Statement'],postAuthor:'Synthetic Example',
    posted_at_iso:'2026-09-05T11:00:00Z',time_target_matched:true,time_confidence:'high',
    time_target_match_method:'direct_post_url',time_precision:'exact',time_is_estimated:false,
    contact:{identityStatus:'matched',phone:'+44 1632 960123',phoneVerified:true,phoneSource:'facebook-page-page-text',sourceUrl:'https://www.facebook.com/example/about'},
    address:{full:'Synthetic premises London SW1A 1AA',verified:true,source:'facebook-page-contact',sourceUrl:'https://www.facebook.com/example/about'} };
  const response = {lead,fetchResults:{rawData:raw},analysis:{verdict:'GOOD',needs_manual_review:false,
    reasoning:'Synthetic opening',business_identity:{relationship:'self',businessName:'Synthetic Example',evidenceQuote:raw.postText}}};
  mutate(response);
  store.insert('9007199254740993123','run-test',{},lead,NOW);
  store.complete('9007199254740993123',assess(response,NOW));
  return store;
}
const ack = {status:'COMPLETED',run_id:'42',records_received:1,records_inserted:1,errors:0,validation_jobs_created:0};
test('maps verified contacts and exact viewer headers, preserving IDs and stable dates', t=>{
  const s=fixture(t),before=s.snapshot(),p=deliveryPlan(s,config,NOW);
  assert.equal(p.counts.ready,1);
  const row=p.entries[0].row;
  assert.deepEqual(Object.keys(row).slice(0,9),VIEWER_HEADERS);
  assert.equal(row['Phone Number'],'01632960123');
  assert.equal(row['Search Post ID'],'9007199254740993123');
  assert.equal(row.Timestamp,'2026-09-05T12:00:00.000Z');
  assert.equal(row[VIEWER_HEADERS[5]],'');
  assert.deepEqual(deliveryPlan(s,config,NOW+100).entries,p.entries);
  assert.deepEqual(s.snapshot(),before);
});
test('expired, rejected, ambiguous identity, and missing verified contacts never deliver',t=>{
  assert.equal(deliveryPlan(fixture(t),config,NOW+86400000).counts.ready,0);
  for (const mutate of [r=>r.analysis.verdict='BAD',r=>r.analysis.needs_manual_review=true,
    r=>r.analysis.business_identity.relationship='third_party',r=>r.fetchResults.rawData.contact.phoneVerified=false,
    r=>r.fetchResults.rawData.address.verified=false]) {
    assert.equal(deliveryPlan(fixture(t,mutate),config,NOW).counts.ready,0);
  }
});
test('checkpoint before send; successful receipt survives restore without redelivery',async t=>{
  const s=fixture(t);let durable,calls=0;
  s.flush=async()=>{durable=s.snapshot();};
  const options={now:()=>NOW,fetchFn:async(url,request)=>{
    calls++;assert.equal(JSON.parse(durable.meta.find(x=>x.key.startsWith('cot-delivery-')).value).status,'sending');
    assert.equal(request.redirect,'error');assert.equal(JSON.parse(request.body).rows.length,1);
    return {ok:true,json:async()=>ack};
  }};
  assert.equal((await deliverReady(s,config,options)).delivered,1);
  const restored=new Store(mkdtempSync(path.join(os.tmpdir(),'cot-delivery-restore-')));t.after(()=>restored.close());
  restored.restore(durable);
  await deliverReady(restored,config,options);assert.equal(calls,1);
});
test('lost responses and failed/partial/replayed RUNNING acknowledgments block automatic replay',async t=>{
  for(const data of [null,{...ack,status:'RUNNING'},{...ack,errors:1},{...ack,records_received:0}]) {
    const s=fixture(t);let calls=0;
    const options={now:()=>NOW,fetchFn:async()=>{calls++;if(!data)throw Error('secret response');return {ok:true,json:async()=>data};}};
    assert.equal((await deliverReady(s,config,options)).status,'delivery_uncertain');
    await deliverReady(s,config,options);assert.equal(calls,1);
    assert.equal(deliveryPlan(s,config,NOW).counts.blocked,1);
  }
});
test('disabled, unreviewed destination and failed checkpoints make no requests',async t=>{
  const s=fixture(t),fetchFn=async()=>{assert.fail('must not send');};
  assert.equal((await deliverReady(s,{...config,enabled:false},{fetchFn})).status,'delivery_disabled');
  await assert.rejects(()=>deliverReady(s,{...config,queueReviewed:false},{fetchFn}),/ACTIVATION/);
  s.flush=async()=>{throw Error('disk');};
  await assert.rejects(()=>deliverReady(s,config,{now:()=>NOW,fetchFn}),/disk/);
});
test('destination config requires explicit source and rejects credential or path URLs',()=>{
  assert.throws(()=>deliveryConfig({TECHIES_DELIVERY_BASE_URL:'https://destination.example'}));
  for(const url of ['http://destination.example','https://secret@destination.example','https://destination.example/path']) {
    assert.throws(()=>deliveryConfig({TECHIES_DELIVERY_BASE_URL:url,TECHIES_DELIVERY_SOURCE:'MFULL'}));
  }
});

test('each invocation sends at most three rows and rechecks expiry before sending',async t=>{
  const s=fixture(t),record=s.rows()[0];
  for(let i=0;i<4;i++) {
    s.insert(`extra${i}`,'run-test',{},JSON.parse(record.lead),NOW);
    s.complete(`extra${i}`,JSON.parse(record.result));
  }
  let calls=0;
  const result=await deliverReady(s,config,{now:()=>NOW,fetchFn:async()=>{calls++;return {ok:true,json:async()=>ack};}});
  assert.equal(calls,3);assert.equal(result.counts.ready,2);
  let clock=NOW;
  await deliverReady(s,config,{now:()=>clock,beforeSend:async()=>{clock=NOW+86400000;},fetchFn:async()=>assert.fail('expired')});
});
