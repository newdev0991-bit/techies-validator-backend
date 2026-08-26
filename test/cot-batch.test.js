import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCotActorInput,
  cotBatchFingerprint,
  indexCotActorItems,
  readCotBatch
} from '../src/cot-batch.js';

const rows = [
  {
    clientRowId: 'run-1:0',
    rowIndex: 0,
    lead: { 'Company Name': 'Alpha', 'Lead Proof URL': 'https://facebook.com/a' }
  },
  {
    clientRowId: 'run-1:1',
    rowIndex: 1,
    lead: { 'Company Name': 'Beta', 'Lead Proof URL': 'https://facebook.com/b' }
  }
];

test('reads a strict COT batch and rejects ambiguous identities', () => {
  assert.deepEqual(readCotBatch({ batchId: 'batch:abc:0,1', leads: rows }).rows, rows);
  assert.match(readCotBatch({ batchId: 'bad id', leads: rows }).error, /unsupported/);
  assert.match(readCotBatch({ batchId: 'x', leads: [rows[0], { ...rows[1], rowIndex: 0 }] }).error, /Duplicate rowIndex/);
  assert.match(readCotBatch({ batchId: 'x', leads: new Array(4).fill(rows[0]) }).error, /between 1 and 3/);
});

test('fingerprints semantic payloads independently of object key order', () => {
  const reordered = rows.map((row) => ({
    lead: Object.fromEntries(Object.entries(row.lead).reverse()),
    rowIndex: row.rowIndex,
    clientRowId: row.clientRowId
  }));
  assert.equal(cotBatchFingerprint(rows), cotBatchFingerprint(reordered));
});

test('builds and validates the Actor requestKey contract without trusting dataset order', () => {
  const entries = rows.map((row, index) => ({
    requestKey: row.clientRowId,
    url: `https://facebook.com/${index}`,
    lead: row.lead
  }));
  const input = buildCotActorInput(entries, [{ name: 'c_user', value: '1' }]);
  assert.deepEqual(input.requests.map((entry) => entry.requestKey), ['run-1:0', 'run-1:1']);

  const items = entries.map((entry) => ({
    contractVersion: 'cot-data-batch-v1',
    requestKey: entry.requestKey,
    inputUrl: entry.url
  })).reverse();
  const indexed = indexCotActorItems(entries, items);
  assert.equal(indexed.get('run-1:0').inputUrl, 'https://facebook.com/0');

  assert.throws(
    () => indexCotActorItems(entries, [{ ...items[0], contractVersion: 'legacy' }]),
    /contract mismatch/
  );
  assert.throws(
    () => indexCotActorItems(entries, [items[0], { ...items[0] }]),
    /duplicate requestKey/
  );
});

