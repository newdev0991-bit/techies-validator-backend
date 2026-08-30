import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApifyClient } from 'apify-client';
import { Store } from '../pipeline/store.mjs';
import { CloudLease,CloudState } from './state.mjs';
import { resultSnapshot } from './results.mjs';

export function readSnapshot(filename) {
  // Never open the historical source through Store: its constructor writes schema/PRAGMAs.
  const db=new DatabaseSync(filename,{readOnly:true});
  try {
    db.exec('BEGIN');
    return Object.fromEntries(['meta','leads','quarantine','runs','daily'].map(table=>
      [table,db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  } finally {db.close();}
}

export function migrationPlan(snapshot) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'cot-cloud-migration-'));
  const store=new Store(directory);
  try {
    store.restore(snapshot);
    return {schemaVersion:'cot-cloud-migration-v1',sourceHash:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      counts:{leads:snapshot.leads.length,runs:snapshot.runs.length,quarantine:snapshot.quarantine.length},
      totals:store.totals(),results:resultSnapshot(store,Date.now(),false)};
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
}

export async function initializeStorage(kv,lease,snapshot,config) {
  await lease.assert();
  // A failed or deleted initialization must be reconciled, never silently reset.
  for(const key of ['STATE','INITIALIZATION','CONFIG','RESULTS'])
    if(await kv.getRecord(key)) throw new Error('CLOUD_STORAGE_NOT_EMPTY_RECONCILE_FIRST');
  const plan=migrationPlan(snapshot);
  const marker={schemaVersion:plan.schemaVersion,sourceHash:plan.sourceHash,counts:plan.counts,totals:plan.totals};
  await kv.setRecord({key:'INITIALIZATION',value:marker});
  await kv.setRecord({key:'CONFIG',value:{...config,enabled:false}});
  await kv.setRecord({key:'RESULTS',value:plan.results});
  await new CloudState(kv,lease).save(snapshot);
  const restored=await new CloudState(kv,lease).load();
  if(migrationPlan(restored).sourceHash!==plan.sourceHash) throw new Error('MIGRATION_VERIFICATION_FAILED');
  return marker;
}

export const scheduleDefinition=(actorId,stateStoreId,lockQueueId)=>({
  name:'techies-cot-cloud-pipeline',title:'Techies COT pipeline (prepared, disabled)',
  cronExpression:'* * * * *',timezone:'UTC',isEnabled:false,isExclusive:true,
  actions:[{type:'RUN_ACTOR',actorId,runInput:{body:JSON.stringify({enabled:true,stateStoreId,lockQueueId}),contentType:'application/json'},
    runOptions:{build:'latest',timeoutSecs:900,memoryMbytes:512,restartOnError:false}}]
});

async function main() {
  const [command,filename]=process.argv.slice(2);
  if(!['plan','bundle','initialize','schedule'].includes(command)) throw new Error('USE_plan_bundle_initialize_DATABASE_OR_schedule');
  const snapshot=command!=='schedule'?readSnapshot(path.resolve(filename||'pipeline/canary-data/pipeline.sqlite')):null;
  if(command==='plan') {
    const {results,...plan}=migrationPlan(snapshot);
    console.log(JSON.stringify({...plan,resultCounts:results.counts,enabled:false},null,2));return;
  }
  if(command==='bundle') {
    const directory=path.resolve('pipeline/cloud-migration');
    // A fresh directory makes every manual upload bundle auditable; no overwrites.
    mkdirSync(directory);
    const records=new Map();
    const kv={async getRecord(key){return records.has(key)?{value:records.get(key)}:undefined;},
      async setRecord({key,value}){records.set(key,value);}};
    const config=JSON.parse(readFileSync(new URL('../pipeline/config.canary.example.json',import.meta.url)));
    const marker=await initializeStorage(kv,{async assert(){}},snapshot,config);
    for(const [key,value] of records) writeFileSync(path.join(directory,`${key}.json`),JSON.stringify(value,null,2));
    console.log(JSON.stringify({directory,keys:[...records.keys()],...marker},null,2));return;
  }
  if(!process.env.APIFY_API_TOKEN) throw new Error('APIFY_API_TOKEN_REQUIRED_IN_SECURE_ENVIRONMENT');
  const client=new ApifyClient({token:process.env.APIFY_API_TOKEN,maxRetries:0,timeoutSecs:30});
  if(command==='schedule') {
    const actorId=process.env.COT_CLOUD_ACTOR_ID;
    if(!actorId) throw new Error('COT_CLOUD_ACTOR_ID_REQUIRED');
    const storeId=process.env.COT_CLOUD_STORE_ID,queueId=process.env.COT_CLOUD_LOCK_QUEUE_ID;
    if(!storeId||!queueId) throw new Error('CLOUD_STORAGE_IDS_REQUIRED');
    const actor=await client.actor(actorId).get();
    if(actor?.name!=='techies-cot-cloud-pipeline') throw new Error('CONTROLLER_ACTOR_ID_MISMATCH');
    for await(const schedule of client.schedules().list()) if(schedule.name==='techies-cot-cloud-pipeline')
      throw new Error('SCHEDULE_EXISTS_INSPECT_WITHOUT_OVERWRITING');
    const schedule=await client.schedules().create(scheduleDefinition(actorId,storeId,queueId));
    if(schedule.isEnabled) throw new Error('UNEXPECTED_ENABLED_SCHEDULE');
    console.log(JSON.stringify({scheduleId:schedule.id,isEnabled:false}));return;
  }
  const storeId=process.env.COT_CLOUD_STORE_ID,queueId=process.env.COT_CLOUD_LOCK_QUEUE_ID;
  if(!storeId||!queueId) throw new Error('CLOUD_STORAGE_IDS_REQUIRED');
  const kv=client.keyValueStore(storeId),queue=client.requestQueue(queueId,{clientKey:randomUUID()});
  const lease=new CloudLease(queue);
  if(!await lease.acquire()) throw new Error('CLOUD_CONTROLLER_BUSY');
  try {
    const config=JSON.parse(readFileSync(new URL('../pipeline/config.canary.example.json',import.meta.url)));
    console.log(JSON.stringify(await initializeStorage(kv,lease,snapshot,config),null,2));
  } finally {await lease.release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(/^[A-Z_]+$/.test(error.message)?error.message:'CLOUD_SETUP_FAILED_CHECK_CONFIGURATION');process.exitCode=1;});
}
