import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Providers } from './providers.mjs';
import { Runner } from './runner.mjs';
import { recover } from './recovery.mjs';

const command = process.argv[2] || 'plan';
const filename = process.env.PIPELINE_CONFIG || path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json');
let store;
try {
  const c = await loadConfig(filename);
  if (command === 'plan') {
    console.log(JSON.stringify({ enabled: c.enabled, actorId: c.actorId, queries: c.queries,
      tickSeconds: c.tickSeconds, minimumPauseAfterCycleSeconds: c.searchIntervalSeconds,
      dailySearchLimit: c.maxSearchRunsPerDay, dailyValidationCallLimit: c.maxValidationCallsPerDay,
      lifetimeSearchLimit: c.maxSearchRunsTotal ?? null, lifetimeValidationCallLimit: c.maxValidationCallsTotal ?? null,
      maximumApifySearchUsdPerDay: c.maxSearchRunsPerDay*c.searchRun.maxTotalChargeUsd,
      maximumApifyValidationUsdPerDay: c.maxValidationCallsPerDay*c.maxValidationActorChargeUsd,
      excludes: 'OpenAI, hosting, taxes and platform billing rounding; ceilings are not usage estimates',
      outputDir: c.outputDir }, null, 2));
  } else {
    store = new Store(c.dataDir);
    if (command === 'status') console.log(JSON.stringify({ cycle:store.get('cycle'), batch:store.get('batch'),
      halted:store.get('halted'), lastTick:store.get('lastTick'), stored:store.count() },null,2));
    else if (command === 'tick') {
      // Config files and deployment alone never turn on paid recurring work.
      const enabled = c.enabled && process.env.PIPELINE_LIVE_ENABLED === 'true';
      const result = await new Runner({...c,enabled},store,new Providers(c)).tick();
      console.log(JSON.stringify(result));
      if (result.status === 'halted') process.exitCode=2;
    } else if (['attach-run','retry-batch','resume','recover-bounded-searches','recover-preflight'].includes(command)) {
      console.log(JSON.stringify(await recover(command,process.argv.slice(3),c,store,new Providers(c))));
    } else throw new Error('Unknown pipeline command');
  }
} catch (error) {
  // Avoid emitting tokens, HTTP bodies or lead contents through scheduler logs.
  console.error(JSON.stringify({status:'error',code:/^[A-Z_0-9]{1,100}$/.test(error.code||'')?error.code:'PIPELINE_COMMAND_FAILED'}));
  process.exitCode=1;
} finally { store?.close(); }
