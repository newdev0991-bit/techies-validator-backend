import assert from 'node:assert/strict';
import test from 'node:test';

import { apifyRequestTimeoutSecs } from '../server.js';
import { apifyFailure } from '../src/apify-errors.js';

// Regression guard for the 2026-09-08 production halt. A batch was answered with
// a bare 500 BATCH_FAILED 30.4s after the Actor started, and the lead pipeline
// turned that into VALIDATION_RESULT_UNCERTAIN and stopped for 2.5 hours. The
// cause was a client request timeout of 30s sitting underneath a 60s status poll.

function withEnv(value, fn) {
  const previous = process.env.APIFY_REQUEST_TIMEOUT_SECS;
  if (value === undefined) delete process.env.APIFY_REQUEST_TIMEOUT_SECS;
  else process.env.APIFY_REQUEST_TIMEOUT_SECS = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.APIFY_REQUEST_TIMEOUT_SECS;
    else process.env.APIFY_REQUEST_TIMEOUT_SECS = previous;
  }
}

test('the request timeout outlives a status poll the API is allowed to hold open', () => {
  assert.ok(withEnv(undefined, apifyRequestTimeoutSecs) > 60,
    'a timeout at or below the 60s waitForFinish cap aborts a healthy poll');
});

test('the request timeout stays inside the batch deadline', () => {
  // COT_BATCH_DEADLINE_MS bottoms out at 60_000 but defaults to 420_000; a single
  // request must not be able to consume the whole batch budget on its own.
  assert.ok(withEnv('360', apifyRequestTimeoutSecs) <= 360);
});

test('an operator cannot reintroduce a timeout below the poll window', () => {
  for (const attempt of ['30', '60', '0', '-1', 'soon']) {
    assert.ok(withEnv(attempt, apifyRequestTimeoutSecs) > 60,
      `APIFY_REQUEST_TIMEOUT_SECS=${attempt} must fall back rather than truncate a poll`);
  }
});

test('an aborted poll is unclassifiable, which is why it surfaced as a bare 500', () => {
  // apify-client raises a transport error, not an ApifyApiError, when its own
  // request timeout fires. Nothing downstream can tell that apart from a bug,
  // so the fix has to be keeping the timeout from firing on a healthy run.
  const transportTimeout = Object.assign(new Error('Timeout awaiting socket'), {
    name: 'RequestError', code: 'ETIMEDOUT'
  });
  assert.equal(apifyFailure(transportTimeout), null);
});
