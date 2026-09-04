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

test('a spend or quota refusal is reported as a quota problem, not a permissions one', () => {
  // "Monthly usage hard limit exceeded" arrives as a 403 alongside genuine permission
  // denials. Telling an operator to check token permissions sends them to the wrong
  // dashboard; the account simply has to be topped up or the cap raised.
  for (const type of ['platform-feature-disabled', 'monthly-usage-hard-limit-reached']) {
    const result = apifyFailure({ name: 'ApifyApiError', statusCode: 403, type });
    assert.equal(result.code, 'APIFY_USAGE_LIMIT');
    assert.match(result.message, /usage limit|spend/i);
    assert.equal(result.diagnostic.providerType, type);
  }
});

test('a payment refusal is also a usage limit rather than a generic account error', () => {
  const result = apifyFailure({ name: 'ApifyApiError', statusCode: 402, type: 'payment-required' });
  assert.equal(result.code, 'APIFY_USAGE_LIMIT');
});

test('an ordinary 403 still reads as an access problem', () => {
  const result = apifyFailure({ name: 'ApifyApiError', statusCode: 403, type: 'forbidden' });
  assert.equal(result.code, 'APIFY_ACCESS_DENIED');
});
