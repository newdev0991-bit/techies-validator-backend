import assert from 'node:assert/strict';
import test from 'node:test';

import {
    backoffDelayMs,
    buildGoogleSearchUrl,
    GOOGLE_SERP_HEADERS,
    GOOGLE_SERP_USER_AGENT,
} from '../src/googleSerp.js';

test('the search URL carries the result-count, language, region and safety params Google expects', () => {
    const url = new URL(buildGoogleSearchUrl('"Salon 77" site:co.uk'));

    assert.equal(url.searchParams.get('q'), '"Salon 77" site:co.uk');
    assert.equal(url.searchParams.get('hl'), 'en');
    assert.equal(url.searchParams.get('gl'), 'uk');
    assert.equal(url.searchParams.get('safe'), 'active');
    assert.equal(url.searchParams.get('num'), '12');
});

test('Google caps a page at 100 results, so a larger request is clamped rather than rejected', () => {
    const url = new URL(buildGoogleSearchUrl('anything', { numResults: 500 }));

    assert.equal(url.searchParams.get('num'), '100');
});

test('the request presents the lightweight-page user agent and pre-answers the consent gate', () => {
    assert.equal(GOOGLE_SERP_HEADERS['user-agent'], GOOGLE_SERP_USER_AGENT);
    assert.match(GOOGLE_SERP_USER_AGENT, /IEMobile/);
    assert.match(GOOGLE_SERP_HEADERS.cookie, /CONSENT=/);
    assert.match(GOOGLE_SERP_HEADERS.cookie, /SOCS=/);
});

test('backoff grows exponentially so a rate-limited retry waits longer than the first', () => {
    const first = backoffDelayMs(0, 1000);
    const third = backoffDelayMs(2, 1000);

    assert.ok(first >= 1000 && first < 2000);
    assert.ok(third >= 4000 && third < 5000);
});
