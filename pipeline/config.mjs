import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ACTOR_ID = '53bGXKeIhVmNMTCi4';
const positive = (v, max) => Number.isFinite(v) && v > 0 && v <= max;
export function validateConfig(c) {
  if (c.actorId !== ACTOR_ID) throw new Error('The search Actor must be 53bGXKeIhVmNMTCi4.');
  if (typeof c.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  const limits = { tickSeconds: [60, 60], searchIntervalSeconds: [60, 86400],
    maxSearchRunsPerDay: [1, 1440], maxValidationCallsPerDay: [1, 1000],
    maxValidationAttempts: [1, 3], validationBatchSize: [1, 3],
    validationTimeoutSeconds: [30, 900], maxDatasetItems: [1, 10000], maxStoredLeads: [1, 100000] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (!Number.isSafeInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`Invalid ${key}.`);
  }
  for (const key of ['maxSearchRunsTotal','maxValidationCallsTotal']) {
    if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > 100000)) throw new Error(`Invalid ${key}.`);
  }
  if (!Array.isArray(c.queries) || !c.queries.length || c.queries.length > 50
      || c.queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 500)) throw new Error('Provide 1-50 nonempty queries, at most 500 characters each.');
  const s = c.searchInput;
  if (!s || s.usePeriodFilter !== true || s.period !== 'last_24_hours' || s.recent_posts !== true
      || typeof s.location_uid !== 'string' || !/^\d+$/.test(s.location_uid)
      || !Number.isSafeInteger(s.maxResults) || s.maxResults < 1 || s.maxResults > c.maxDatasetItems
      || !Number.isSafeInteger(s.maxPages) || s.maxPages < 1 || s.maxPages > 50
      || !Number.isSafeInteger(s.maxRequests) || s.maxRequests < 1 || s.maxRequests > 60
      || !Number.isSafeInteger(s.pageSize) || s.pageSize < 1 || s.pageSize > 20
      || !Number.isSafeInteger(s.maxRetries) || s.maxRetries < 0 || s.maxRetries > 2
      || !Number.isSafeInteger(s.timeoutMs) || s.timeoutMs < 1000 || s.timeoutMs > 30000) throw new Error('Search input must have bounded requests/results and a rolling 24-hour window.');
  const allowed = new Set(['maxResults','recent_posts','location_uid','usePeriodFilter','period','maxPages','maxRequests','pageSize','maxRetries','timeoutMs']);
  const contactLimits = { maxAuthorRequests: [0, 40], authorTimeoutMs: [1000, 30000],
    googleFallbackBudgetMs: [10000, 90000], googleSearchTimeoutMs: [5000, 20000] };
  for (const [key, [min, max]] of Object.entries(contactLimits)) {
    allowed.add(key);
    if (s[key] !== undefined && (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max)) throw new Error(`Invalid ${key}.`);
  }
  allowed.add('includeGoogleFallback');
  if (s.includeGoogleFallback !== undefined && typeof s.includeGoogleFallback !== 'boolean') throw new Error('Invalid includeGoogleFallback.');
  if (Object.keys(s).some(k => !allowed.has(k))) throw new Error('Unsupported search input field.');
  if (!positive(c.searchRun?.timeout, 300) || ![128,256,512,1024].includes(c.searchRun?.memory)
      || !positive(c.searchRun?.maxTotalChargeUsd, 5) || !positive(c.maxValidationActorChargeUsd, 5)) throw new Error('Run timeout, memory and cost ceilings are required.');
  if (Object.keys(c.searchRun).some(k => !['timeout','memory','maxTotalChargeUsd'].includes(k))) throw new Error('Unsupported run option.');
  const url = new URL(c.validatorBaseUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS validator URL (HTTP only for loopback tests).');
  if (!c.dataDir || !c.outputDir) throw new Error('Persistent data and output directories are required.');
  return c;
}

export async function loadConfig(filename) {
  const file = path.resolve(filename);
  const c = validateConfig(JSON.parse(await readFile(file, 'utf8')));
  return { ...c, dataDir: path.resolve(path.dirname(file), c.dataDir), outputDir: path.resolve(path.dirname(file), c.outputDir) };
}
