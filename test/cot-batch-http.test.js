import assert from 'node:assert/strict';
import test from 'node:test';

import { createCotBatchHandler } from '../server.js';

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

test('deadline retains batch ownership and replays late success without a second provider call', async () => {
  let resolveWork, calls = 0;
  const active = new Map();
  const handler = createCotBatchHandler({
    deadlineMs: 10, activeBatchesMap: active, completedBatchesMap: new Map(),
    runBatchFn: () => { calls++; return new Promise(resolve => { resolveWork = resolve; }); }
  });
  const first = responseRecorder();
  await handler({ body: batchBody() }, first);
  assert.equal(first.statusCode, 503);
  assert.equal(active.size, 1);
  const retry = responseRecorder();
  await handler({ body: batchBody() }, retry);
  assert.equal(retry.statusCode, 503);
  assert.equal(calls, 1);
  const conflict = responseRecorder();
  await handler({ body: batchBody('Different') }, conflict);
  assert.equal(conflict.statusCode, 409);
  const response = { success: true, batchId: 'cot:test:0', results: [] };
  resolveWork(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active.size, 0);
  const completed = responseRecorder();
  await handler({ body: batchBody() }, completed);
  assert.deepEqual(completed.body, response);
  assert.equal(calls, 1);
});

test('late provider rejection after a deadline releases ownership without an unhandled rejection', async () => {
  let rejectWork;
  const active = new Map();
  const handler = createCotBatchHandler({
    deadlineMs: 10, activeBatchesMap: active, completedBatchesMap: new Map(),
    runBatchFn: () => new Promise((_, reject) => { rejectWork = reject; })
  });
  await handler({ body: batchBody() }, responseRecorder());
  assert.equal(active.size, 1);
  rejectWork(new Error('provider ended'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active.size, 0);
});

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

test('an unexpected batch failure logs its cause but does not leak it to the caller', async () => {
  // A 500 here makes the standalone pipeline halt with VALIDATION_RESULT_UNCERTAIN
  // until an operator reconciles. Logging only "Unexpected non-provider error" left
  // a recurring production halt with no evidence to diagnose it.
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  const res = responseRecorder();
  try {
    const handler = createCotBatchHandler({
      activeBatchesMap: new Map(),
      completedBatchesMap: new Map(),
      runBatchFn: async () => {
        throw Object.assign(new Error('OpenAI request exceeded its hard deadline.'), { name: 'AbortError' });
      }
    });
    await handler({ body: batchBody() }, res);
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body?.error?.code, 'BATCH_FAILED');
  assert.ok(!JSON.stringify(res.body).includes('OpenAI'));
  const all = logged.join('\n');
  assert.match(all, /Unexpected non-provider error/);
  assert.match(all, /AbortError/);
  assert.match(all, /hard deadline/);
});
