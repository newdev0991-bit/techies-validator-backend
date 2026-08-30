import { ApifyClient } from 'apify-client';
import { mkdtemp,readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../pipeline/store.mjs';
import { Runner } from '../pipeline/runner.mjs';
import { Providers } from '../pipeline/providers.mjs';
import { validateConfig } from '../pipeline/config.mjs';
import { CloudLease,CloudState } from './state.mjs';
import { resultSnapshot } from './results.mjs';

// No new long-lived Apify secret is needed inside the Actor: use its run token.
const client=new ApifyClient({token:process.env.APIFY_TOKEN,maxRetries:0,timeoutSecs:30});
const defaultStore=client.keyValueStore(process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID);
const input=(await defaultStore.getRecord('INPUT'))?.value || {};
const storeId=process.env.COT_CLOUD_STORE_ID;
const queueId=process.env.COT_CLOUD_LOCK_QUEUE_ID;
if(!storeId || !queueId || !process.env.APIFY_ACTOR_RUN_ID) throw new Error('CLOUD_STORAGE_NOT_CONFIGURED');
const kv=client.keyValueStore(storeId);
const queue=client.requestQueue(queueId,{clientKey:process.env.APIFY_ACTOR_RUN_ID});
const lease=new CloudLease(queue);
if(!await lease.acquire()) {
  await defaultStore.setRecord({key:'OUTPUT',value:{status:'busy'}});
} else {
  let store;
  try {
    const state=new CloudState(kv,lease);
    const snapshot=await state.load();
    // Only the explicit provisioning/migration command may initialize storage.
    if(!snapshot) throw new Error('CLOUD_STATE_NOT_INITIALIZED');
    const directory=await mkdtemp(path.join(os.tmpdir(),'cot-cloud-'));
    store=new Store(path.join(directory,'data'));store.restore(snapshot);
    store.flush=()=>state.save(store.snapshot());
    const base=JSON.parse(await readFile(new URL('../pipeline/config.canary.example.json',import.meta.url)));
    const requested=(await kv.getRecord('CONFIG'))?.value || {};
    // Budget settings are operator-managed in named storage, not overrideable in
    // a scheduled or manual run's input. The default is a single bounded canary.
    const config=validateConfig({...base,...requested,enabled:input.enabled===true && requested.enabled===true && process.env.PIPELINE_LIVE_ENABLED==='true',
      validatorBaseUrl:process.env.COT_VALIDATOR_BASE_URL || base.validatorBaseUrl,
      dataDir:path.join(directory,'data'),outputDir:path.join(directory,'output')});
    if(!config.validatorBaseUrl.startsWith('https://')) throw new Error('CLOUD_VALIDATOR_REQUIRES_HTTPS');
    const providers=new Providers(config,{token:process.env.APIFY_TOKEN});
    for(const method of ['start','validate']) {
      const original=providers[method].bind(providers);
      providers[method]=async(...args)=>{await lease.renew();await lease.assert();return original(...args);};
    }
    const runner=new Runner(config,store,providers);
    const outcome=await runner.tick();
    await lease.assert();
    const view=resultSnapshot(store,Date.now(),config.enabled);
    // One record is the coherent frontend view. Never expose raw responses or credentials.
    if(Buffer.byteLength(JSON.stringify(view))>8*1024*1024) throw new Error('CLOUD_RESULT_SIZE_LIMIT');
    await kv.setRecord({key:'RESULTS',value:view});
    await defaultStore.setRecord({key:'OUTPUT',value:{...outcome,counts:view.counts,storageId:storeId}});
    console.log(JSON.stringify({status:outcome.status,counts:view.counts}));
  } finally {
    store?.close(); await lease.release();
  }
}
