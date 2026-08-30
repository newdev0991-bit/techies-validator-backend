import { createHash } from 'node:crypto';

const tables = ['meta','leads','quarantine','runs','daily'];
const hash = text => createHash('sha256').update(text).digest('hex');
const maxBytes = 64 * 1024 * 1024;

// Content-addressed immutable chunks, then one manifest commit. A killed writer
// can leave orphan chunks, but cannot partially replace the authoritative state.
export class CloudState {
  constructor(kv, lease) { this.kv=kv; this.lease=lease; this.known=new Set(); }
  async load() {
    const manifest=(await this.kv.getRecord('STATE'))?.value;
    if (!manifest) return null;
    if (manifest.schemaVersion !== 'cot-cloud-state-v1' || !manifest.tables) throw new Error('INVALID_CLOUD_STATE');
    const snapshot={}; let size=0;
    for (const table of tables) {
      const refs=manifest.tables[table];
      if (!Array.isArray(refs) || refs.length>1000) throw new Error('INVALID_CLOUD_STATE');
      snapshot[table]=[];
      for (const key of refs) {
        if (!/^chunk-[a-f0-9]{64}$/.test(key)) throw new Error('INVALID_CLOUD_STATE');
        const value=(await this.kv.getRecord(key))?.value;
        const json=JSON.stringify(value);
        if (!Array.isArray(value) || `chunk-${hash(json)}`!==key) throw new Error('CLOUD_STATE_CORRUPT');
        size+=Buffer.byteLength(json);
        if(size>maxBytes) throw new Error('CLOUD_STATE_SIZE_LIMIT');
        snapshot[table].push(...value); this.known.add(key);
      }
    }
    return snapshot;
  }
  async save(snapshot) {
    await this.lease.assert();
    const manifest={schemaVersion:'cot-cloud-state-v1',updatedAt:new Date().toISOString(),tables:{}};
    const chunks=new Map(); let total=0;
    for (const table of tables) {
      manifest.tables[table]=[]; let rows=[],bytes=2;
      const finish=()=>{
        if (!rows.length) return;
        const json=JSON.stringify(rows),key=`chunk-${hash(json)}`;
        manifest.tables[table].push(key); chunks.set(key,rows); rows=[];bytes=2;
      };
      for(const row of snapshot[table]) {
        const size=Buffer.byteLength(JSON.stringify(row))+1; total+=size;
        if(size>4*1024*1024 || total>maxBytes) throw new Error('CLOUD_STATE_SIZE_LIMIT');
        if(bytes+size>512*1024) finish();
        rows.push(row);bytes+=size;
      }
      finish();
    }
    for(const [key,value] of chunks) if(!this.known.has(key)) {
      await this.lease.assert(); await this.kv.setRecord({key,value}); this.known.add(key);
    }
    await this.lease.assert(); await this.kv.setRecord({key:'STATE',value:manifest});
  }
}

// One permanently pending queue request is a distributed mutex, never a URL to
// crawl. Each invocation uses its own clientKey; expired/lost locks fail closed.
export class CloudLease {
  constructor(queue,{now=Date.now,lockSecs=300}={}) { this.q=queue;this.now=now;this.lockSecs=lockSecs;this.deadline=0; }
  async acquire() {
    const added=await this.q.addRequest({url:'https://example.invalid/cot-pipeline-lock',uniqueKey:'cot-pipeline-lock-v1'});
    if(added.wasAlreadyHandled) throw new Error('CLOUD_LOCK_CORRUPT');
    const started=this.now();
    const head=await this.q.listAndLockHead({limit:1,lockSecs:this.lockSecs});
    if(!head.items.length) return false;
    if(head.items[0].id!==added.requestId) throw new Error('CLOUD_LOCK_QUEUE_NOT_DEDICATED');
    this.id=added.requestId;this.deadline=started+this.lockSecs*1000;
    await this.assert();
    this.timer=setInterval(()=>{this.renew().catch(()=>{this.lost=true;});},30000);
    this.timer.unref?.(); return true;
  }
  async renew() {
    if(this.lost || this.now()>=this.deadline-5000) { this.lost=true;throw new Error('CLOUD_LOCK_LOST'); }
    if(this.renewing) return this.renewing;
    const started=this.now();
    this.renewing=(async()=>{await this.q.prolongRequestLock(this.id,{lockSecs:this.lockSecs});this.deadline=started+this.lockSecs*1000;await this.assert();})();
    try { await this.renewing; } catch(e) {this.lost=true;throw e;} finally {this.renewing=null;}
  }
  async assert() { if(!this.id || this.lost || this.now()>=this.deadline-10000) throw new Error('CLOUD_LOCK_LOST'); }
  async release() {
    clearInterval(this.timer);
    if(this.renewing) await this.renewing.catch(()=>{});
    if(this.id && !this.lost && this.now()<this.deadline) await this.q.deleteRequestLock(this.id);
  }
}
