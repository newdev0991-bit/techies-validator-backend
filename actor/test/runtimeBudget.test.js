import assert from 'node:assert/strict';
import test from 'node:test';

import { OperationTimeoutError, runWithTimeout } from '../src/runtimeBudget.js';

test('returns an operation result before its deadline', async () => {
    assert.equal(await runWithTimeout(async () => 'done', { timeoutMs: 50, label: 'quick task' }), 'done');
});

test('fails with a classified timeout and invokes cleanup once', async () => {
    let cleanupCalls = 0;
    await assert.rejects(
        runWithTimeout(() => new Promise(() => {}), {
            timeoutMs: 5,
            label: 'slow task',
            onTimeout: () => {
                cleanupCalls += 1;
            },
        }),
        (error) =>
            error instanceof OperationTimeoutError &&
            error.code === 'OPERATION_TIMEOUT' &&
            /slow task exceeded 5ms/.test(error.message),
    );
    assert.equal(cleanupCalls, 1);
});

test('waits for asynchronous timeout cleanup before rejecting', async () => {
    let cleanupFinished = false;
    await assert.rejects(
        runWithTimeout(() => new Promise(() => {}), {
            timeoutMs: 5,
            onTimeout: async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 5);
                });
                cleanupFinished = true;
            },
        }),
        (error) => error instanceof OperationTimeoutError,
    );
    assert.equal(cleanupFinished, true);
});

test('a late task result cannot win while timeout cleanup is running', async () => {
    let cleanupFinished = false;
    await assert.rejects(
        runWithTimeout(
            async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 15);
                });
                return 'late success';
            },
            {
                timeoutMs: 5,
                onTimeout: async () => {
                    await new Promise((resolve) => {
                        setTimeout(resolve, 40);
                    });
                    cleanupFinished = true;
                },
            },
        ),
        (error) => error instanceof OperationTimeoutError,
    );
    assert.equal(cleanupFinished, true);
});

test('contains a synchronous timeout-cleanup failure', async () => {
    await assert.rejects(
        runWithTimeout(() => new Promise(() => {}), {
            timeoutMs: 5,
            onTimeout: () => {
                throw new Error('cleanup failed');
            },
        }),
        (error) => error instanceof OperationTimeoutError,
    );
});

test('does not invoke timeout cleanup after a task rejects normally', async () => {
    let cleanupCalls = 0;
    await assert.rejects(
        runWithTimeout(
            async () => {
                throw new Error('ordinary failure');
            },
            {
                timeoutMs: 50,
                onTimeout: () => {
                    cleanupCalls += 1;
                },
            },
        ),
        /ordinary failure/,
    );
    assert.equal(cleanupCalls, 0);
});
