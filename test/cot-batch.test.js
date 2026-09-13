import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actorRowFailure,
  buildCotActorInput,
  cotBatchFingerprint,
  indexCotActorItems,
  readCotBatch,
  sessionBlocked
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
  const input = buildCotActorInput(entries);
  assert.equal(input.contactRequirements, 'phone_address');
  assert.equal(Object.hasOwn(input, 'cookies'), false);
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

test('sessionBlocked is systemic: any login wall or IP block fails the whole batch', () => {
  assert.equal(sessionBlocked([{ status: 'success' }, { status: 'error' }]), false);
  assert.equal(sessionBlocked([{ status: 'success' }, { scrape: { blocked: true } }]), true);
  assert.equal(sessionBlocked([{ loginRequired: true }]), true);
  assert.equal(sessionBlocked([{ auth_blocked_target: true }]), true);
});

test('actorRowFailure flags only the row that failed, not its batch-mates', () => {
  assert.equal(actorRowFailure({ status: 'success' }), null);
  assert.equal(actorRowFailure({ status: 'error', error: 'row-error: timeout' }), 'row-error: timeout');
  assert.equal(actorRowFailure({ status: 'error' }), 'error');
  assert.equal(actorRowFailure(undefined), 'unknown');
});

test('regression: one bad row no longer throws for the batch -- 2026-09-12/13 incident', () => {
  // Before this fix, runFacebookActorBatch threw 'actor_row_failure' for the whole
  // batch whenever any row wasn't status:'success' and didn't match a "not found"
  // message -- discarding nine good rows over one bad one, and looping forever
  // when that row's failure was not transient (the same 10-row batch re-ran
  // identically for 90+ minutes). The fix moves this decision to buildFetchResults'
  // existing per-row success signal; this only guards the classification helpers
  // that decision is built on stay batch-wide for a real session block and
  // per-row for everything else.
  const actorRows = [
    { status: 'success' },
    { status: 'error', error: 'row-error: proof-document-has-no-dated-story' },
    { status: 'success' }
  ];
  assert.equal(sessionBlocked(actorRows), false);
  assert.deepEqual(actorRows.map(actorRowFailure), [null, 'row-error: proof-document-has-no-dated-story', null]);
});
