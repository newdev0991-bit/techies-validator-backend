import assert from 'node:assert/strict';
import test from 'node:test';

import { apifyRequestTimeoutSecs, cotBatchWaitSecs } from '../server.js';
import { cotActorPhaseOptions } from '../src/pipeline-capabilities.js';

// Regression: the batch/proof ApifyClient hard-coded timeoutSecs: 30, which
// aborts a normal 60s run-status poll and throws a transport error the batch
// handler cannot classify -> opaque 500 -> pipeline VALIDATION_RESULT_UNCERTAIN.
// The per-request timeout must stay clear of the 60s waitForFinish window.
test('apify request timeout defaults above the 60s poll window', () => {
  delete process.env.APIFY_REQUEST_TIMEOUT_SECS;
  assert.equal(apifyRequestTimeoutSecs(), 120);
});

test('apify request timeout override is honoured but floored above 60s', () => {
  process.env.APIFY_REQUEST_TIMEOUT_SECS = '90';
  assert.equal(apifyRequestTimeoutSecs(), 90);
  for (const bad of ['30', '60', '0', '-5', 'nope']) {
    process.env.APIFY_REQUEST_TIMEOUT_SECS = bad;
    assert.equal(apifyRequestTimeoutSecs(), 120, `"${bad}" must fall back to the safe default`);
  }
  delete process.env.APIFY_REQUEST_TIMEOUT_SECS;
});

// Regression: production ran with a 60s batch wait while proof runs carry a 120s
// Actor timeout. On 2026-09-14 proof runs of 64s and 68s were still RUNNING when
// call() returned, the batch answered 504 APIFY_TIMEOUT, and the lead pipeline
// halted for ~20 hours -- although both runs SUCCEEDED seconds later. The wait
// must outlast the run's own timeout, so call() always sees a terminal status.
test('batch wait always outlasts the phase Actor timeout, whatever the env says', () => {
  const env = { COT_ACTOR_MAX_CHARGE_USD: '0.20' };
  for (const phase of ['proof', 'contacts']) {
    const { timeout } = cotActorPhaseOptions(phase, env);
    for (const configured of [undefined, '10', '60', '120', 'nope']) {
      const wait = cotBatchWaitSecs(timeout, { APIFY_BATCH_WAIT_SECS: configured });
      assert.ok(wait > timeout, `${phase}: wait ${wait}s must exceed the ${timeout}s run timeout (env ${configured})`);
    }
    assert.equal(cotBatchWaitSecs(timeout, { APIFY_WAIT_SECS: '60' }), timeout + 30);
  }
  assert.equal(cotBatchWaitSecs(120, {}), 300, 'the 300s default still applies when it is longer');
  assert.equal(cotBatchWaitSecs(120, { APIFY_BATCH_WAIT_SECS: '240' }), 240);
  // Both phases' waits fit inside the default 420s batch deadline.
  assert.ok(cotBatchWaitSecs(120, { APIFY_BATCH_WAIT_SECS: '10' }) + cotBatchWaitSecs(180, { APIFY_BATCH_WAIT_SECS: '10' }) < 420);
});
