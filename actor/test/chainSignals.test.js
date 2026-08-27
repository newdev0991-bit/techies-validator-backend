import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChainSignals } from '../src/chainSignals.js';

test('multiple-location wording is classified as a chain', () => {
  assert.deepEqual(classifyChainSignals(['Multiple-location wording']), {
    isChain: true,
    isFranchise: false,
  });
});

test('franchise wording is both franchise and chain evidence', () => {
  assert.deepEqual(classifyChainSignals(['Explicit franchise wording']), {
    isChain: true,
    isFranchise: true,
  });
});

test('ordinary independent-business signals remain unclassified', () => {
  assert.deepEqual(classifyChainSignals([]), {
    isChain: false,
    isFranchise: false,
  });
});
