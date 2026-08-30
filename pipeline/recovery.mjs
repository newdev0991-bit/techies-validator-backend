import { isDeepStrictEqual } from 'node:util';

export async function recover(command,args,c,s,p) {
  if (!s.acquire()) throw new Error('Worker is busy');
  try {
    const cycle=s.get('cycle'), batch=s.get('batch');
    if (command==='attach-run') {
      if (cycle?.phase!=='starting' || !/^[A-Za-z0-9]+$/.test(args[0]||'')) throw new Error('No uncertain search to attach');
      const run=await p.run(args[0]);
      if (run?.id!==args[0] || run.actId!==c.actorId || !run.defaultKeyValueStoreId
          || !Number.isFinite(Date.parse(run.startedAt)) || Date.parse(run.startedAt)<cycle.createdAt-60000) throw new Error('Run mismatch');
      const input=await p.input(run.defaultKeyValueStoreId);
      if (Object.keys(cycle.input).some(k=>!isDeepStrictEqual(input?.[k],cycle.input[k]))) throw new Error('Input mismatch');
      s.transaction(()=>{s.set('cycle',{...cycle,phase:'searching',runId:run.id});s.set('halted',null);});
    } else if (command==='retry-batch') {
      if (!batch || batch.attempts>=c.maxValidationAttempts || !args.includes('--acknowledge-possible-charge')) throw new Error('Explicit charge acknowledgement and remaining attempts required');
      s.transaction(()=>{s.set('batch',{...batch,phase:'ready',nextAttemptAt:0});s.set('halted',null);});
    } else {
      if (cycle?.phase==='starting' || batch?.phase==='sending') throw new Error('Reconcile uncertain paid operation first');
      s.transaction(()=>{s.set('halted',null);s.set('incompleteSearches',0);});
    }
    return {status:'recovered',command};
  } finally {s.release();}
}
