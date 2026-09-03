import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../pipeline/store.mjs';
import {Runner} from '../../pipeline/runner.mjs';
import {resultSnapshot} from '../results.mjs';
import {processingGates,controllerReport,reportHtml,publishReport} from '../report.mjs';

const base=JSON.parse(readFileSync(new URL('../../pipeline/config.canary.example.json',import.meta.url)));
test('each disabled gate prevents provider calls and reports all blockers without resetting history',async t=>{
  for(let mask=0;mask<7;mask++) {
    const dir=mkdtempSync(path.join(os.tmpdir(),'cot-report-')),s=new Store(dir);t.after(()=>s.close());
    s.charge('2026-08-30','searches');s.charge('2026-08-30','validations');
    s.insert('saved','prior',{}, {'Company Name':'Saved lead'},1);
    const gates=processingGates({enabled:!!(mask&1)},{enabled:!!(mask&2)},
      {PIPELINE_LIVE_ENABLED:mask&4?'true':'false',SECRET:'must not leak'});
    let calls=0;const fail=async()=>{calls++;throw Error('Provider must not be called');};
    const config={...base,enabled:gates.enabled,outputDir:path.join(dir,'output')};
    const result=await new Runner(config,s,new Proxy({}, {get:()=>fail})).tick();
    const report=controllerReport(result,resultSnapshot(s,Date.now(),config.enabled),config,gates,'store');
    assert.equal(calls,0);assert.equal(report.status,'disabled');assert.equal(report.savedLeadCount,1);
    assert.equal(report.lifetimeBudget.searches.remaining,0);assert.equal(report.lifetimeBudget.validations.remaining,0);
    assert.deepEqual({...s.totals()},{searches:1,validations:1});
    assert.equal(gates.blockers.length,3-Number(!!(mask&1))-Number(!!(mask&2))-Number(!!(mask&4)));
    assert.match(report.message,/No search or validation attempted/);
    assert.ok(!JSON.stringify(report).includes('must not leak'));
  }
  assert.equal(processingGates({enabled:true},{enabled:true},{PIPELINE_LIVE_ENABLED:'true'}).enabled,true);
  assert.equal(processingGates({enabled:'true'},{enabled:true},{PIPELINE_LIVE_ENABLED:'true'}).enabled,false);
  assert.equal(processingGates({enabled:true},{enabled:true},{PIPELINE_LIVE_ENABLED:true}).enabled,false);
});

test('exhausted allowance is explained even with all gates on; no fresh-day bypass',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'cot-report-')),s=new Store(dir);t.after(()=>s.close());
  s.charge('2026-08-30','searches');let calls=0;
  const config={...base,enabled:true,outputDir:path.join(dir,'output')};
  const outcome=await new Runner(config,s,new Proxy({}, {get:()=>async()=>{calls++;}}),
    {now:()=>Date.parse('2026-09-01T00:00:00Z')}).tick();
  const gates=processingGates({enabled:true},{enabled:true},{PIPELINE_LIVE_ENABLED:'true'});
  const report=controllerReport(outcome,resultSnapshot(s,Date.now(),true),config,gates,'store');
  assert.equal(calls,0);assert.equal(report.status,'total_search_limit');
  assert.match(report.message,/Lifetime allowance exhausted/);assert.equal(report.lifetimeBudget.searches.remaining,0);
});

test('HTML report escapes injected content, distinguishes saved counts and does not execute scripts',()=>{
  const html=reportHtml({message:'<script>alert(1)</script>',generatedAt:'<img onerror=x>',
    counts:{READY:0,REVIEW_REQUIRED:2,REJECTED:1,PENDING:0},
    lifetimeBudget:{searches:{used:1,limit:1,remaining:0}}});
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));
  assert.match(html,/&lt;script&gt;/);assert.match(html,/default-src 'none'/);
  assert.match(html,/not the number of leads collected/);assert.match(html,/0 remaining of 1/);
  assert.ok(!reportHtml({status:'busy',message:'Lock held'}).includes('Saved lead counts'));
});

test('Console status uses terminal explanation and report survives an optional status update failure',async()=>{
  const records=new Map();let update;
  const kv={async setRecord(record){records.set(record.key,record);}};
  const report={status:'disabled',message:'Paused: CONFIG.enabled is not true.'};
  await publishReport({run(id){assert.equal(id,'run');return {async update(value){update=value;}};}},kv,'run',report);
  assert.equal(update.isStatusMessageTerminal,true);assert.equal(update.statusMessage,report.message);
  assert.deepEqual(records.get('OUTPUT').value,report);assert.match(records.get('REPORT.html').contentType,/text\/html/);
  await publishReport({run(){return {async update(){throw Error('transient failure');}};}},kv,'run',report);
  assert.deepEqual(records.get('OUTPUT').value,report);
});


test('readiness reports explain attempts and next check without claiming new leads',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'cot-readiness-report-')),s=new Store(dir);t.after(()=>s.close());
  const now=Date.parse('2026-09-03T10:00:00Z'),nextAttemptAt=now+60000;
  s.set('preflightRetry',{code:'PROVIDER_CONNECTION_UNCERTAIN',attempts:1,nextAttemptAt});
  const config={...base,enabled:true},gates={enabled:true,blockers:[]};
  const view=resultSnapshot(s,now,true,config,gates);
  assert.equal(view.diagnostics.nextEligibleSearchAt,new Date(nextAttemptAt).toISOString());
  for(const status of ['preflight_retry','preflight_backoff']) {
    const report=controllerReport({status,...s.get('preflightRetry')},view,config,gates,'store');
    assert.ok(report.message.includes('1/3 attempts used'));assert.match(report.message,/No search or validation submitted/);
    assert.match(report.message,/10:01:00/);
  }
});
