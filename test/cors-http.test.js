import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test('CORS permits the production aliases and project deployment origins', async t => {
  const api = http.createServer(app);
  const address = await listen(api);
  t.after(() => close(api));
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const allowedOrigins = [
    'https://techies-validator2026.vercel.app',
    'https://techies-validator-frontend-2026-jehu-zachary-sedillos-projects.vercel.app',
    'https://techies-validator-frontend-2026-a1b2c3d4.vercel.app',
    'https://techies-validator-frontend-2026-a1b2c3d4-jehu-zachary-sedillos-projects.vercel.app',
    'https://techies-validator-frontend-2026-git-codex-cot-validator-v2-jehu-zachary-sedillos-projects.vercel.app',
    'https://techies-validator-fro-git-main-jehu-zachary-sedillos-projects.vercel.app'
  ];

  for (const origin of allowedOrigins) {
    const response = await fetch(`${apiUrl}/health`, { headers: { origin } });
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), origin, origin);
  }
});

test('CORS answers an allowed project preflight with the requested origin', async t => {
  const api = http.createServer(app);
  const address = await listen(api);
  t.after(() => close(api));
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const origin =
    'https://techies-validator-frontend-2026-git-freshness-fix-jehu-zachary-sedillos-projects.vercel.app';

  const response = await fetch(`${apiUrl}/analyze`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type'
    }
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('access-control-allow-methods') || '', /\bPOST\b/);
  assert.match(response.headers.get('access-control-allow-headers') || '', /content-type/i);
});

test('CORS rejects unknown origins with a stable JSON error for requests and preflights', async t => {
  const api = http.createServer(app);
  const address = await listen(api);
  t.after(() => close(api));
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const origin = 'https://techies-validator-frontend-2026.evil.example';
  const expectedError = {
    error: {
      code: 'ORIGIN_NOT_ALLOWED',
      message: 'Request origin is not allowed.'
    }
  };

  const requestResponse = await fetch(`${apiUrl}/health`, { headers: { origin } });
  assert.equal(requestResponse.status, 403);
  assert.equal(requestResponse.headers.get('access-control-allow-origin'), null);
  assert.match(requestResponse.headers.get('content-type') || '', /^application\/json\b/);
  assert.deepEqual(await requestResponse.json(), expectedError);

  const preflightResponse = await fetch(`${apiUrl}/analyze`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type'
    }
  });
  assert.equal(preflightResponse.status, 403);
  assert.equal(preflightResponse.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await preflightResponse.json(), expectedError);
});
