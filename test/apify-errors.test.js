import assert from 'node:assert/strict';
import test from 'node:test';
import { apifyFailure, checkApifyAccess } from '../src/apify-errors.js';

test('provider diagnostics never expose arbitrary provider data', () => {
  const result = apifyFailure({ name: 'ApifyApiError', statusCode: 403,
    type: 'SECRET_TOKEN', message: 'SECRET_COOKIE', stack: 'SECRET_LEAD',
    request: { url: 'https://example.com/?token=SECRET' } });
  assert.equal(result.code, 'APIFY_ACCESS_DENIED');
  assert.equal(result.diagnostic.providerType, 'unclassified');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('provider error statuses remain terminal rather than triggering paid retries', () => {
  for (const statusCode of [400, 401, 402, 403, 404, 429, 500]) {
    const result = apifyFailure({ name: 'ApifyApiError', statusCode, type: 'invalid-input' });
    assert.equal(result.status, 502);
    assert.equal(result.diagnostic.providerStatus, statusCode);
  }
  assert.equal(apifyFailure(new Error('internal')), null);
});

test('preflight only reads Actor and default build, without starting a run', async () => {
  const calls = [];
  const actor = {
    get: async () => { calls.push('actor'); return { id: 'actor' }; },
    defaultBuild: async () => ({ get: async () => { calls.push('build'); return { status: 'SUCCEEDED' }; } }),
    call: () => assert.fail('must not start paid work')
  };
  assert.equal(await checkApifyAccess(actor, () => {}), true);
  assert.deepEqual(calls, ['actor', 'build']);
});

test('preflight reports inaccessible actors and safely logs API rejection', async () => {
  assert.equal(await checkApifyAccess({ get: async () => undefined }, () => {}), false);
  const logs = [];
  assert.equal(await checkApifyAccess({ get: async () => {
    throw { name: 'ApifyApiError', statusCode: 401, type: 'invalid-token', message: 'SECRET' };
  } }, line => logs.push(line)), false);
  assert.match(logs[0], /invalid-token/);
  assert.doesNotMatch(logs[0], /SECRET/);
});
