import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';
import { Runner } from '../runner.mjs';
import { Providers, ProviderError } from '../providers.mjs';
import { validateConfig } from '../config.mjs';
import { recover } from '../recovery.mjs';
import { csvCell, exportFiles } from '../exports.mjs';
import { enrichCotContacts } from '../../src/cot-contacts.js';
import { pipelineActorOptions, pipelineAccess } from '../../src/pipeline-capabilities.js';
import { qualifySearchPost, searchLead } from '../records.mjs';
import { resultSnapshot } from '../../cloud/results.mjs';
import { searchOutcome } from '../search-outcome.mjs';

const base=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url)));
const NOW=Date.parse('2026-08-30T12:00:00Z');
const post=(id='9007199254740993123')=>({schemaVersion:'facebook-search-posts-v1',post_id:id,
  url:`https://www.facebook.com/example/posts/${id}`,author:{name:'Synthetic Example'},message:'We are opening our new premises.',posted_at:'2026-08-30T11:00:00Z'});
function response(payload,mutate=()=>{}) {
  return {success:true,batchId:payload.batchId,results:payload.leads.map(e=>{
    const url=e.lead['Lead Proof URL'];
    const raw={inputUrl:url,postUrl:url,status:'success',scrape:{success:true},business:{identityStatus:'matched'},
      postText:'We are opening our new premises.',postAuthor:'Synthetic Example',
      posted_at_iso:'2026-08-30T11:00:00Z',time_target_matched:true,time_confidence:'high',time_target_match_method:'direct_post_url',time_precision:'exact',time_is_estimated:false,
      contact:{identityStatus:'matched',phone:'+44 1632 960123',phoneVerified:true,phoneSource:'facebook-page-page-text',sourceUrl:'https://www.facebook.com/example/about'},
      address:{full:'Synthetic premises London SW1A 1AA',verified:true,source:'facebook-page-contact',sourceUrl:'https://www.facebook.com/example/about'}};
    const row={...e,success:true,fetchResults:{rawData:raw},analysis:{verdict:'GOOD',needs_manual_review:false,reasoning:'Synthetic business opening',
      business_identity:{relationship:'self',businessName:'Synthetic Example',evidenceQuote:raw.postText}}};
    mutate(row);row.analysis.contact_enrichment=enrichCotContacts({...row.lead,fetchResults:row.fetchResults});return row;
  })};
}
function fixture(t,rows=[post()]) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'techies-pipeline-test-'));
  const c=validateConfig({...structuredClone(base),enabled:true,dataDir:path.join(dir,'data'),outputDir:path.join(dir,'output')});
  const s=new Store(c.dataDir);t.after(()=>s.close());
  let clock=NOW;const calls={start:0,validate:0,preflight:0,items:[]};
  const p={async preflight(){calls.preflight++;},async start(){calls.start++;return {id:'run1',actId:c.actorId};},
    async run(){return {id:'run1',actId:c.actorId,status:'SUCCEEDED',defaultDatasetId:'dataset1',defaultKeyValueStoreId:'kv1'};},
    async summary(){return {schemaVersion:'facebook-search-run-v1',success:true,partial:false,stoppingReason:'max_results'};},
    async dataset(){return {itemCount:rows.length};},async items(id,offset,limit){calls.items.push(offset);return rows.slice(offset,offset+limit);},
    async validate(payload){calls.validate++;return response(payload);}};
  const runner=new Runner(c,s,p,{now:()=>clock});
  return {c,s,p,runner,calls,advance:(ms)=>{clock+=ms;},now:()=>clock};
}
async function ingest(f){assert.equal((await f.runner.tick()).status,'search_started');assert.equal((await f.runner.tick()).status,'search_ingested');}

test('cloud snapshots and operational exports preserve validation history across expiry',async t=>{
  const f=fixture(t);await ingest(f);await f.runner.tick();await f.runner.tick();
  const original=f.s.snapshot(),validatedAt=JSON.parse(f.s.rows()[0].result).validatedAt;
  const boundary=Date.parse('2026-08-31T11:00:00Z');
  for(const clock of [boundary-1,boundary,boundary+1]) {
    const view=resultSnapshot(f.s,clock,true,f.c);
    assert.equal(view.schemaVersion,'cot-cloud-results-v2');
    assert.equal(view.rows[0].status,clock>boundary?'EXPIRED':'READY');
    assert.equal(view.rows[0].validatedAt,validatedAt);
    assert.equal(view.rows[0].validationStatus,'READY');
    assert.equal(view.runMetrics[0].readyAtValidation,1);
    const exported=await exportFiles(f.s,f.c.outputDir,clock);
    assert.equal(exported.counts.expired,clock>boundary?1:0);
    assert.equal(exported.counts.enriched,clock>boundary?0:1);
  }
  assert.deepEqual(f.s.snapshot(),original);
});

test('corrupt search rows halt before paid validation',async t=>{
  const f=fixture(t,[{...post(),schemaVersion:'unrecognized'}]);
  await f.runner.tick();assert.equal((await f.runner.tick()).code,'INVALID_SEARCH_DATASET');
  await f.runner.tick();assert.equal(f.calls.validate,0);
});

test('bounded partial cycles continue without reporting completeness or bypassing lifetime limits',async t=>{
  const f=fixture(t);f.c.maxSearchRunsTotal=3;
  f.p.run=async()=>({id:'run1',actId:f.c.actorId,status:'FAILED',defaultDatasetId:'dataset1',defaultKeyValueStoreId:'kv1'});
  f.p.summary=async()=>({schemaVersion:'facebook-search-run-v1',query:f.s.get('cycle').input.query,success:false,partial:true,firstPageAccepted:true,
    resultCount:1,pageCount:f.c.searchInput.maxPages,requestCount:f.c.searchInput.maxRequests,stoppingReason:'PAGE_BUDGET_EXHAUSTED'});
  for(let i=0;i<3;i++){
    await ingest(f);if(i===0) await f.runner.tick();
    const done=await f.runner.tick();assert.equal(done.searchOutcome,'bounded_partial');
    assert.equal(f.s.get('incompleteSearches'),0);f.advance(300000);
  }
  assert.equal((await f.runner.tick()).status,'total_search_limit');assert.equal(f.calls.start,3);
  const metric=resultSnapshot(f.s,f.now(),true,f.c).runMetrics[0];
  assert.equal(metric.outcome,'bounded_partial');assert.equal(metric.raw,1);
});

test('partial classification rejects mismatching or empty evidence',()=>{
  const input={query:'our new premises',maxPages:3,maxRequests:8,maxResults:20};
  const cycle={input,total:9,runStatus:'FAILED',summary:{schemaVersion:'facebook-search-run-v1',query:input.query,partial:true,success:false,
    firstPageAccepted:true,resultCount:9,pageCount:3,requestCount:6,stoppingReason:'PAGE_BUDGET_EXHAUSTED'}};
  assert.equal(searchOutcome(cycle),'bounded_partial');
  for(const change of [{query:'wrong'},{resultCount:0},{pageCount:2},{requestCount:9},{firstPageAccepted:false},{stoppingReason:'TIMEOUT'}])
    assert.equal(searchOutcome({...cycle,summary:{...cycle.summary,...change}}),'failed');
});

test('recovery dry run verifies provider evidence and apply preserves counters with processing disabled',async t=>{
  const f=fixture(t);f.c.enabled=false;f.c.maxSearchRunsTotal=3;
  const input={...f.c.searchInput,query:'our new premises'};
  const summary={schemaVersion:'facebook-search-run-v1',query:input.query,partial:true,success:false,firstPageAccepted:true,
    resultCount:1,pageCount:input.maxPages,requestCount:input.maxRequests,stoppingReason:'PAGE_BUDGET_EXHAUSTED'};
  for(let i=0;i<3;i++){f.s.charge('2026-09-01','searches');f.s.auditRun({id:`cycle${i}`,runId:`run${i}`,input,total:1,createdAt:i,completedAt:i,
    datasetId:`data${i}`,kvId:`kv${i}`,runStatus:'FAILED',summary});}
  f.s.set('incompleteSearches',3);f.s.set('halted',{code:'REPEATED_INCOMPLETE_SEARCHES'});
  f.p.run=async id=>({id,actId:f.c.actorId,status:'FAILED',defaultDatasetId:`data${id.slice(-1)}`,defaultKeyValueStoreId:`kv${id.slice(-1)}`});
  f.p.input=async()=>input;f.p.summary=async()=>summary;f.p.dataset=async()=>({itemCount:1});
  const before=f.s.snapshot();const report=await recover('recover-bounded-searches',[],f.c,f.s,f.p);
  assert.equal(report.eligible,true);assert.deepEqual(f.s.snapshot(),before);
  f.s.set('batch',{phase:'sending'});assert.equal((await recover('recover-bounded-searches',[],f.c,f.s,f.p)).eligible,false);f.s.set('batch',null);
  await recover('recover-bounded-searches',['--apply'],f.c,f.s,f.p);
  assert.equal(f.s.get('halted'),null);assert.equal(f.s.totals().searches,3);
  f.c.enabled=true;assert.equal((await f.runner.tick()).status,'total_search_limit');assert.equal(f.calls.start,0);
});

test('v2 author contacts survive ingestion, validator payload, cloud snapshot and separate source export without becoming verified', async t => {
  const source = { ...post(), schemaVersion: 'facebook-search-posts-v2', author: {
    name: 'Synthetic Example', id: '12345', url: 'https://www.facebook.com/example',
    phone: '01632 960999', address: '12 Example Road, London SW1A 1AA', website: 'example.test',
    contactSource: 'google-official-website', contactIdentityConfidence: 'high', verified: true, privateToken: 'do-not-copy' } };
  const f = fixture(t, [source]); await ingest(f);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM quarantine').get().n, 0);
  const lead = JSON.parse(f.s.pending(1)[0].lead);
  assert.equal(lead['Phone Number'], source.author.phone);
  assert.equal(lead['Address 1'], source.author.address);
  assert.equal(lead['Post Code'], 'SW1A 1AA');
  assert.equal(JSON.parse(lead['Search Author Contact']).verified, false);
  assert.doesNotMatch(lead['Search Author Contact'], /privateToken/);
  assert.equal(resultSnapshot(f.s, NOW, false).rows[0].searchAuthor.phone, source.author.phone);
  f.p.validate = async payload => {
    assert.deepEqual(payload.leads[0].lead, lead);
    return response(payload, row => { row.fetchResults.rawData.contact = {}; row.fetchResults.rawData.address = {}; });
  };
  await f.runner.tick();
  const view = resultSnapshot(f.s, NOW, false).rows[0];
  assert.equal(view.status, 'REVIEW_REQUIRED'); assert.equal(view.phone, ''); assert.equal(view.address, '');
  assert.equal(view.searchAuthor.phone, source.author.phone);
  assert.doesNotMatch(readFileSync(path.join(f.c.outputDir, 'enriched.csv'), 'utf8'), /01632 960999/);
  assert.match(readFileSync(path.join(f.c.outputDir, 'search-contacts.csv'), 'utf8'), /01632 960999/);
  assert.match(readFileSync(path.join(f.c.outputDir, 'search-contacts.csv'), 'utf8'), /UNVERIFIED_AUTHOR_CONTACT/);
});

test('legacy search rows stay compatible; unknown schemas and malformed IDs remain quarantinable', () => {
  assert.equal(searchLead({ ...post(), author: { name: 'Synthetic', phone: 'untrusted-v1-field' } })['Phone Number'], '');
  assert.throws(() => searchLead({ ...post(), schemaVersion: 'facebook-search-posts-v3' }), /INVALID_SEARCH_POST_ID/);
  assert.throws(() => searchLead({ ...post(), post_id: 123 }), /INVALID_SEARCH_POST_ID/);
});

test('strict search qualification keeps explicit business events and drops noisy move language', async t => {
  const keep = [
    'We are opening our new premises next week.',
    'Grand opening - our new local shop opens Saturday.',
    "We've relocated to Beverley - our new address is Unit 5.",
    'The cafe is under new ownership.'
  ];
  const drop = [
    'I am moving house next week.',
    'Willing to relocate for the right role.',
    'Our removals company helps clients relocating abroad.',
    'New menu launching soon.'
  ];
  keep.forEach(message => assert.equal(qualifySearchPost({ message }).qualified, true, message));
  drop.forEach(message => assert.equal(qualifySearchPost({ message }).qualified, false, message));

  const rows = [post('1'), { ...post('2'), message: drop[0] }, { ...post('3'), message: drop[2] }];
  const f = fixture(t, rows); await ingest(f);
  assert.equal(f.s.count(), 1);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM quarantine WHERE reason LIKE ?').get('LOW_INTENT_SEARCH_RESULT:%').n, 2);
  assert.equal(f.s.pending(3).length, 1);
});

test('author enrichment options remain bounded and preserve explicit disable switches', () => {
  const config = structuredClone(base);
  Object.assign(config.searchInput, { maxAuthorRequests: 0, authorTimeoutMs: 1000, includeGoogleFallback: false,
    googleFallbackBudgetMs: 10000, googleSearchTimeoutMs: 5000 });
  assert.equal(validateConfig(config).searchInput.maxAuthorRequests, 0);
  for (const [key, value] of Object.entries({ maxAuthorRequests: 41, authorTimeoutMs: 30001,
    googleFallbackBudgetMs: 90001, googleSearchTimeoutMs: 20001, includeGoogleFallback: 'true' })) {
    const bad = structuredClone(config); bad.searchInput[key] = value;
    assert.throws(() => validateConfig(bad), new RegExp(key));
  }
});

test('search -> COT -> verified CSV, cooldown, durable cross-cycle deduplication',async t=>{
  const f=fixture(t);await ingest(f);assert.equal((await f.runner.tick()).status,'validated');
  const csv=readFileSync(path.join(f.c.outputDir,'enriched.csv'),'utf8');
  assert.match(csv,/9007199254740993123/);assert.match(csv,/01632960123/);assert.match(csv,/SW1A 1AA/);
  assert.equal((await f.runner.tick()).status,'cycle_complete');assert.equal((await f.runner.tick()).status,'waiting');
  f.advance(300000);await ingest(f);assert.equal((await f.runner.tick()).status,'cycle_complete');
  assert.equal(f.calls.validate,1);assert.equal(f.s.count(),1);
});
test('disabled and overlapping workers cannot perform network work',async t=>{
  const f=fixture(t);f.c.enabled=false;assert.equal((await f.runner.tick()).status,'disabled');assert.equal(f.calls.preflight,0);
  f.c.enabled=true;const second=new Store(f.c.dataDir);t.after(()=>second.close());assert.equal(second.acquire(),true);
  assert.equal((await f.runner.tick()).status,'busy');assert.equal(f.calls.start,0);second.release();
});
test('pending rows and pagination survive restart; corrupt IDs are quarantined and halt validation',async t=>{
  const rows=Array.from({length:101},(_,i)=>post(String(i+1)));rows.push({...post(),post_id:123});
  const f=fixture(t,rows);await f.runner.tick();assert.equal((await f.runner.tick()).status,'ingesting');
  const second=new Store(f.c.dataDir);t.after(()=>second.close());const r=new Runner(f.c,second,f.p,{now:f.now});
  assert.equal((await r.tick()).code,'INVALID_SEARCH_DATASET');assert.deepEqual(f.calls.items,[0,100]);
  assert.equal(second.count(),101);assert.equal(second.db.prepare('SELECT count(*) n FROM quarantine').get().n,1);
  assert.equal((await r.tick()).status,'halted');assert.equal(f.calls.start,1);assert.equal(f.calls.validate,0);
});
test('failed partial search retains rows and audit; failed empty run is incomplete',async t=>{
  for(const rows of [[post()],[]]){
    const f=fixture(t,rows);const old=f.p.run;f.p.run=async()=>({...await old(),status:'FAILED'});
    f.p.summary=async()=>({success:false,partial:true,stoppingReason:'request_limit'});
    await f.runner.tick();const r=await f.runner.tick();assert.equal(r.searchComplete,false);assert.equal(f.s.count(),rows.length);
    assert.equal(JSON.parse(f.s.db.prepare('SELECT record FROM runs').get().record).runStatus,'FAILED');
  }
});
test('uncertain paid start halts across restart without a second POST',async t=>{
  const f=fixture(t);f.p.start=async()=>{f.calls.start++;throw new Error('lost response');};
  assert.equal((await f.runner.tick()).code,'SEARCH_START_UNCERTAIN');
  assert.equal((await f.runner.tick()).status,'halted');assert.equal(f.calls.start,1);
  await assert.rejects(()=>recover('resume',[],f.c,f.s,f.p));
  f.p.run=async()=>({id:'recovered',actId:f.c.actorId,defaultKeyValueStoreId:'kv',startedAt:new Date(NOW).toISOString()});
  f.p.input=async()=>f.s.get('cycle').input;
  await recover('attach-run',['recovered'],f.c,f.s,f.p);assert.equal(f.s.get('cycle').runId,'recovered');assert.equal(f.calls.start,1);
});
test('lost validation response is not automatically charged again',async t=>{
  const f=fixture(t);await ingest(f);f.p.validate=async()=>{f.calls.validate++;throw new ProviderError('PROVIDER_CONNECTION_UNCERTAIN');};
  assert.equal((await f.runner.tick()).code,'VALIDATION_RESULT_UNCERTAIN');await f.runner.tick();assert.equal(f.calls.validate,1);
  await assert.rejects(()=>recover('retry-batch',[],f.c,f.s,f.p));
});
test('named transient 503 retries preserve batch identity, backoff and daily charge accounting',async t=>{
  const f=fixture(t);await ingest(f);let first;
  f.p.validate=async payload=>{f.calls.validate++;if(!first){first=payload;throw new ProviderError('actor_partial_batch',503);}assert.deepEqual(payload,first);return response(payload);};
  assert.equal((await f.runner.tick()).status,'validation_retry');assert.equal((await f.runner.tick()).status,'validation_backoff');
  f.advance(60000);assert.equal((await f.runner.tick()).status,'validated');assert.equal(f.s.daily('2026-08-30').validations,2);
});
test('daily validation budget prevents another search; unavailable capabilities prevent spending',async t=>{
  const f=fixture(t);f.c.maxValidationCallsPerDay=1;await ingest(f);await f.runner.tick();await f.runner.tick();f.advance(300000);
  assert.equal((await f.runner.tick()).status,'daily_validation_limit');assert.equal(f.calls.start,1);
  const g=fixture(t);g.p.preflight=async()=>{throw new ProviderError('VALIDATOR_NOT_READY');};
  assert.equal((await g.runner.tick()).code,'VALIDATOR_NOT_READY');assert.equal(g.calls.start,0);
});
test('row identity mismatch commits no batch result',async t=>{
  const f=fixture(t,[post('1'),post('2')]);await ingest(f);
  f.p.validate=async payload=>{const r=response(payload);r.results[1].clientRowId='wrong';return r;};
  assert.equal((await f.runner.tick()).code,'VALIDATION_CONTRACT_MISMATCH');assert.equal(f.s.pending(3).length,2);
});
test('canary lifetime limits cannot restart paid work after midnight',async t=>{
  const f=fixture(t);f.c.maxSearchRunsTotal=1;f.c.maxValidationCallsTotal=1;
  await ingest(f);await f.runner.tick();await f.runner.tick();f.advance(86400000);
  assert.equal((await f.runner.tick()).status,'total_search_limit');assert.equal(f.calls.start,1);assert.equal(f.calls.validate,1);
});
test('three incomplete cycles stop recurring searches after preserving their audit',async t=>{
  const f=fixture(t,[]);f.p.summary=async()=>({success:false,partial:true});
  for(let i=0;i<3;i++){
    await ingest(f);const r=await f.runner.tick();assert.equal(r.status,i===2?'halted':'cycle_complete');f.advance(300000);
  }
  assert.equal(f.s.get('halted').code,'REPEATED_INCOMPLETE_SEARCHES');await f.runner.tick();assert.equal(f.calls.start,3);
});
test('unverified contact or search-only date never enters enriched CSV; exports age out stale proofs',async t=>{
  const f=fixture(t,[post('1'),post('2'),post('3')]);await ingest(f);
  f.p.validate=async payload=>response(payload,r=>{if(r.rowIndex===1)delete r.fetchResults.rawData.address.verified;if(r.rowIndex===2)delete r.fetchResults.rawData.posted_at_iso;});
  await f.runner.tick();let status=JSON.parse(readFileSync(path.join(f.c.outputDir,'status.json')));
  assert.deepEqual(status.counts,{enriched:1,review:2,rejected:0,expired:0});
  f.advance(86400000);status=await exportFiles(f.s,f.c.outputDir,f.now());assert.equal(status.counts.enriched,0);
  assert.equal(f.calls.validate,0); // replaced provider above; export must not invoke it
});
test('provider start is single-shot, keeps tokens out of URL, sends bounded options',async()=>{
  let calls=0;
  const p=new Providers(base,{token:'synthetic-token',fetchFn:async(url,options)=>{
    calls++;const u=new URL(url);assert.equal(u.searchParams.get('maxTotalChargeUsd'),'0.1');
    assert.equal(u.searchParams.get('restartOnError'),'false');assert.equal(u.searchParams.has('token'),false);
    assert.equal(options.headers.Authorization,'Bearer synthetic-token');throw new Error('network');}});
  await assert.rejects(()=>p.start({query:'test'}),{code:'PROVIDER_CONNECTION_UNCERTAIN'});assert.equal(calls,1);
});

test('old GOOD answers cannot export unresolved or third-party publishers even with complete contacts', async t => {
  const f=fixture(t,[post('1'),post('2'),post('3')]);await ingest(f);
  f.p.validate=async payload=>response(payload,r=>{
    if(r.rowIndex===1) delete r.analysis.business_identity;
    if(r.rowIndex===2) r.fetchResults.rawData.postText='Good luck to the new business opening nearby!';
  });
  await f.runner.tick();
  const exported=await exportFiles(f.s,f.c.outputDir,f.now());
  assert.deepEqual(exported.counts,{enriched:1,review:2,rejected:0,expired:0});
  const review=readFileSync(path.join(f.c.outputDir,'review.csv'),'utf8');
  assert.match(review,/business identity: unresolved/);
  assert.match(review,/business identity: third_party/);
  assert.doesNotMatch(review,/01632960123/);
});
test('config caps, scheduler API access, and formula escaping fail closed',()=>{
  assert.throws(()=>validateConfig({...base,searchInput:{...base.searchInput,maxResults:0}}));
  assert.throws(()=>validateConfig({...base,searchRun:{...base.searchRun,restartOnError:true}}));
  assert.equal(pipelineActorOptions({}),null);assert.deepEqual(pipelineActorOptions({COT_ACTOR_MAX_CHARGE_USD:'0.2'}),{maxTotalChargeUsd:0.2,timeout:300,restartOnError:false});
  const res={status(n){assert.equal(n,401);return this;},json(){return this;}};
  pipelineAccess({get:()=>''},res,()=>assert.fail('unauthorized'));
  assert.equal(csvCell('=HYPERLINK("https://evil")'),'"\'=HYPERLINK(""https://evil"")"');
  assert.equal(csvCell('01632960123'),'"01632960123"');
});
