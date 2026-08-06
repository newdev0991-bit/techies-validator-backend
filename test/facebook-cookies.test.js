import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFacebookCookies } from '../server.js';

function setCookies(domain) {
  process.env.FACEBOOK_COOKIES = JSON.stringify([
    { name: 'c_user', value: 'test-value', domain }
  ]);
}

test('Facebook cookies accept only the Facebook apex domain or its subdomains', t => {
  const original = process.env.FACEBOOK_COOKIES;
  t.after(() => {
    if (original === undefined) delete process.env.FACEBOOK_COOKIES;
    else process.env.FACEBOOK_COOKIES = original;
  });

  for (const domain of ['facebook.com', '.facebook.com', 'www.facebook.com', '.m.facebook.com']) {
    setCookies(domain);
    assert.equal(parseFacebookCookies()[0].domain, domain);
  }
});

test('Facebook cookies reject lookalike and parent-domain suffix attacks', t => {
  const original = process.env.FACEBOOK_COOKIES;
  t.after(() => {
    if (original === undefined) delete process.env.FACEBOOK_COOKIES;
    else process.env.FACEBOOK_COOKIES = original;
  });

  for (const domain of [
    'evilfacebook.com',
    '.evilfacebook.com',
    'facebook.com.evil.example',
    'not-facebook.com'
  ]) {
    setCookies(domain);
    assert.throws(
      () => parseFacebookCookies(),
      error => error?.status === 503 && error?.code === 'FACEBOOK_AUTH_INVALID',
      domain
    );
  }
});
