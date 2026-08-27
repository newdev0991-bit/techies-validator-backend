import assert from 'node:assert/strict';
import test from 'node:test';

import { completedBatchRequestKeys } from '../src/batchResume.js';

const requests = [
    { requestKey: '0', url: 'https://www.facebook.com/alpha' },
    { requestKey: '1', url: 'https://www.facebook.com/beta' },
    { requestKey: '2', url: 'https://www.facebook.com/gamma' },
];

test('a migrated Actor resumes after rows already saved in the run dataset', () => {
    const completed = completedBatchRequestKeys(requests, [
        { requestKey: '0', inputUrl: 'https://www.facebook.com/alpha' },
    ]);

    assert.deepEqual([...completed], ['0']);
    assert.equal(completed.has('1'), false);
});

test('duplicate stored copies still identify one completed request', () => {
    const completed = completedBatchRequestKeys(requests, [
        { requestKey: '0', inputUrl: 'https://www.facebook.com/alpha' },
        { requestKey: '0', inputUrl: 'https://www.facebook.com/alpha' },
    ]);

    assert.deepEqual([...completed], ['0']);
});

test('resume fails closed when a stored key belongs to a different URL', () => {
    assert.throws(
        () => completedBatchRequestKeys(requests, [
            { requestKey: '0', inputUrl: 'https://www.facebook.com/not-alpha' },
        ]),
        /Stored batch output URL mismatch for requestKey "0"/,
    );
});

test('unrelated malformed dataset items cannot suppress a requested row', () => {
    const completed = completedBatchRequestKeys(requests, [
        { requestKey: 'unknown', inputUrl: 'https://www.facebook.com/alpha' },
        { requestKey: '', inputUrl: 'https://www.facebook.com/beta' },
    ]);

    assert.equal(completed.size, 0);
});
