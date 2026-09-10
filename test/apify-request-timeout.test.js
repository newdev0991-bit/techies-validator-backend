import assert from 'node:assert/strict';
import test from 'node:test';

import { apifyRequestTimeoutSecs } from '../server.js';

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
