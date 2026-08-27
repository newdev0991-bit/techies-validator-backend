import { createHash } from 'node:crypto';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

export function readCotBatch(body, { maxBatchSize = 3 } = {}) {
  if (!isRecord(body)) return { error: 'Request body must be a JSON object.' };
  const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
  if (!batchId) return { error: 'batchId is required.' };
  if (batchId.length > 240 || !/^[A-Za-z0-9._,:-]+$/.test(batchId)) {
    return { error: 'batchId contains unsupported characters or is too long.' };
  }
  if (!Array.isArray(body.leads) || body.leads.length < 1 || body.leads.length > maxBatchSize) {
    return { error: `leads must contain between 1 and ${maxBatchSize} rows.` };
  }

  const clientRowIds = new Set();
  const rowIndexes = new Set();
  const rows = [];
  for (let position = 0; position < body.leads.length; position += 1) {
    const row = body.leads[position];
    if (!isRecord(row)) return { error: `leads[${position}] must be an object.` };
    const clientRowId = typeof row.clientRowId === 'string' ? row.clientRowId.trim() : '';
    if (!clientRowId || clientRowId.length > 160) {
      return { error: `leads[${position}].clientRowId must be a non-empty string.` };
    }
    if (!Number.isSafeInteger(row.rowIndex) || row.rowIndex < 0) {
      return { error: `leads[${position}].rowIndex must be a non-negative integer.` };
    }
    if (!isRecord(row.lead) || Object.keys(row.lead).length === 0) {
      return { error: `leads[${position}].lead must be a non-empty object.` };
    }
    if (clientRowIds.has(clientRowId)) return { error: `Duplicate clientRowId: ${clientRowId}.` };
    if (rowIndexes.has(row.rowIndex)) return { error: `Duplicate rowIndex: ${row.rowIndex}.` };
    clientRowIds.add(clientRowId);
    rowIndexes.add(row.rowIndex);
    rows.push({ clientRowId, rowIndex: row.rowIndex, lead: row.lead });
  }

  return { batchId, rows };
}

export function cotBatchFingerprint(rows) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(rows)))
    .digest('hex');
}

export function buildCotActorInput(entries, options = {}) {
  return {
    requests: entries.map((entry) => ({
      requestKey: entry.requestKey,
      url: entry.url,
      lead: entry.lead
    })),
    startUrls: entries.map((entry) => ({ url: entry.url })),
    activityWindowDays: options.activityWindowDays || 1,
    maxPosts: options.maxPosts || 10,
    includeContactDetails: true,
    includeGoogleFallback: options.includeGoogleFallback !== false,
    includePageDetails: true,
    includePreviousPosts: true
  };
}

export function indexCotActorItems(entries, items, expectedContract = 'cot-data-batch-v1') {
  if (!Array.isArray(items)) throw new Error('Actor dataset items must be an array.');
  const expected = new Map(entries.map((entry) => [String(entry.requestKey), entry]));
  const indexed = new Map();

  for (const item of items) {
    if (!isRecord(item)) throw new Error('Actor returned a malformed dataset item.');
    if (item.contractVersion !== expectedContract) {
      throw new Error(`Actor contract mismatch (expected ${expectedContract}).`);
    }
    const requestKey = String(item.requestKey ?? '');
    const entry = expected.get(requestKey);
    if (!entry) throw new Error(`Actor returned unknown requestKey "${requestKey}".`);
    if (indexed.has(requestKey)) throw new Error(`Actor returned duplicate requestKey "${requestKey}".`);
    if (String(item.inputUrl || '').trim() !== entry.url) {
      throw new Error(`Actor echoed the wrong URL for requestKey "${requestKey}".`);
    }
    indexed.set(requestKey, item);
  }

  return indexed;
}
