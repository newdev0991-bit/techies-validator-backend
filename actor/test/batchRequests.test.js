import assert from 'node:assert/strict';
import test from 'node:test';

import { buildActorRequests } from '../src/batchRequests.js';

test('batch requests keep per-row lead identity and request keys', () => {
    const requests = buildActorRequests({
        requests: [
            { requestKey: 'row-7', url: 'https://facebook.com/a', lead: { name: 'Alpha' } },
            { requestKey: 'row-8', url: 'https://facebook.com/b', lead: { name: 'Beta' } },
        ],
        lead: { name: 'legacy' },
    });

    assert.deepEqual(requests, [
        { requestKey: 'row-7', url: 'https://facebook.com/a', lead: { name: 'Alpha' } },
        { requestKey: 'row-8', url: 'https://facebook.com/b', lead: { name: 'Beta' } },
    ]);
});

test('legacy startUrls still share the legacy lead object', () => {
    const requests = buildActorRequests({
        startUrls: [{ url: 'https://facebook.com/a' }, { url: 'https://facebook.com/b' }],
        lead: { name: 'Legacy Business' },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].lead.name, 'Legacy Business');
    assert.equal(requests[1].requestKey, '1');
});

test('duplicate batch request keys are rejected instead of producing ambiguous output rows', () => {
    assert.throws(
        () =>
            buildActorRequests({
                requests: [
                    { requestKey: 'row-7', url: 'https://facebook.com/a' },
                    { requestKey: ' row-7 ', url: 'https://facebook.com/b' },
                ],
            }),
        /Duplicate requestKey in batched Actor input: row-7/,
    );
});

test('generated batch request keys cannot collide with explicit keys', () => {
    assert.throws(
        () =>
            buildActorRequests({
                requests: [{ requestKey: '1', url: 'https://facebook.com/a' }, { url: 'https://facebook.com/b' }],
            }),
        /Duplicate requestKey in batched Actor input: 1/,
    );
});
