import assert from 'node:assert/strict';
import test from 'node:test';

import { createCotBatchHandler } from '../server.js';
import { cotActorPhaseOptions } from '../src/pipeline-capabilities.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return value; }
  };
}

function batchBody(name = 'Alpha') {
  return {
    batchId: 'cot:test:0',
    leads: [{
      clientRowId: 'run:0',
      rowIndex: 0,
      lead: { 'Company Name': name, 'Lead Proof URL': 'https://example.com/proof' }
    }]
  };
}

test('COT handler reports safe Apify rejection instead of a generic 500', async () => {
  const handler = createCotBatchHandler({
    completedBatchesMap: new Map(), activeBatchesMap: new Map(),
    runBatchFn: async () => {
      throw { name: 'ApifyApiError', statusCode: 403, type: 'forbidden', message: 'SECRET' };
    }
  });
  const response = responseRecorder();
  await handler({ body: batchBody() }, response);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error.code, 'APIFY_ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(response.body), /SECRET/);
  assert.equal(response.headers['Retry-After'], undefined);
});

test('COT batch handler replays a completed response without rerunning providers', async () => {
  let calls = 0;
  const completedBatchesMap = new Map();
  const handler = createCotBatchHandler({
    completedBatchesMap,
    activeBatchesMap: new Map(),
    runBatchFn: async (batchId, _fingerprint, rows) => {
      calls += 1;
      return {
        success: true,
        batchId,
        results: rows.map((row) => ({ ...row, success: true, analysis: { verdict: 'GOOD' } }))
      };
    }
  });

  const first = responseRecorder();
  await handler({ body: batchBody() }, first);
  const second = responseRecorder();
  await handler({ body: batchBody() }, second);

  assert.equal(calls, 1);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.body.results[0].clientRowId, 'run:0');
});

test('COT batch handler rejects reuse of a batchId for a different payload', async () => {
  const completedBatchesMap = new Map();
  const handler = createCotBatchHandler({
    completedBatchesMap,
    activeBatchesMap: new Map(),
    runBatchFn: async (batchId, _fingerprint, rows) => ({
      success: true,
      batchId,
      results: rows.map((row) => ({ ...row, success: true, analysis: { verdict: 'GOOD' } }))
    })
  });
  await handler({ body: batchBody('Alpha') }, responseRecorder());
  const conflict = responseRecorder();
  await handler({ body: batchBody('Beta') }, conflict);

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error.code, 'batch_id_conflict');
});

test('COT batch handler rejects malformed rows before provider work', async () => {
  let calls = 0;
  const handler = createCotBatchHandler({
    runBatchFn: async () => { calls += 1; }
  });
  const response = responseRecorder();
  await handler({ body: { batchId: 'bad id', leads: [] } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, 'INVALID_BATCH');
  assert.equal(calls, 0);
});

test('a missing required setting is reported as configuration, not a generic failure', async () => {
  // COT_ACTOR_MAX_CHARGE_USD is required by cotActorPhaseOptions and throws before any
  // Apify call. Reported as a bare 500 it is indistinguishable from a broken scraper,
  // which is exactly how an unset variable stayed hidden through a whole deployment.
  const handler = createCotBatchHandler({
    completedBatchesMap: new Map(), activeBatchesMap: new Map(),
    runBatchFn: async () => cotActorPhaseOptions('proof', {})
  });
  const response = responseRecorder();
  await handler({ body: batchBody() }, response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'BACKEND_NOT_CONFIGURED');
  assert.match(response.body.error.message, /COT_ACTOR_MAX_CHARGE_USD/);
});

test('an unrelated internal error still stays opaque', async () => {
  const handler = createCotBatchHandler({
    completedBatchesMap: new Map(), activeBatchesMap: new Map(),
    runBatchFn: async () => { throw new Error('SECRET internal detail'); }
  });
  const response = responseRecorder();
  await handler({ body: batchBody() }, response);

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, 'BATCH_FAILED');
  assert.doesNotMatch(JSON.stringify(response.body), /SECRET/);
});
