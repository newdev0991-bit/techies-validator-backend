import { createHash } from 'node:crypto';
import { assess } from './records.mjs';

export const VIEWER_HEADERS = ['Lead Statement','Timestamp','Company Name','Phone Number',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)','Address 2 (Village/Town/City)',
  'Phone 2','Post Code (Please Put The Full Postcode, Example: CH41 5LH)','Lead Proof URL'];

export function deliveryConfig(env = process.env) {
  if (!['NFULL','MFULL'].includes(env.TECHIES_DELIVERY_SOURCE)) throw Error('DELIVERY_SOURCE_REQUIRED');
  const url = new URL(env.TECHIES_DELIVERY_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('DELIVERY_REQUIRES_HTTPS_ORIGIN');
  }
  return { source: env.TECHIES_DELIVERY_SOURCE, origin: url.origin,
    endpoint: `${url.origin}/internal/ingest/${env.TECHIES_DELIVERY_SOURCE.toLowerCase()}`,
    token: env.TECHIES_DELIVERY_TOKEN, enabled: env.TECHIES_DELIVERY_ENABLED === 'true',
    // Existing ingestion may enqueue another paid validation. Activation must
    // acknowledge that behavior or verify the destination queue is disabled.
    queueReviewed: env.TECHIES_DELIVERY_QUEUE_REVIEWED === 'true' };
}

export function deliveryPlan(store, config, now = Date.now()) {
  const entries = [];
  const counts = { ready: 0, delivered: 0, blocked: 0, ineligible: 0 };
  for (const record of store.rows()) {
    if (record.status !== 'complete') { counts.ineligible++; continue; }
    const saved = JSON.parse(record.result), result = assess(saved.response, now);
    if (result.status !== 'READY') { counts.ineligible++; continue; }
    const lead = JSON.parse(record.lead);
    if (!Number.isFinite(Date.parse(saved.validatedAt))) throw Error('DELIVERY_VALIDATION_DATE_MISSING');
    const values = [lead['Lead Statement'] || '', saved.validatedAt,
      result.identity.businessName || lead['Company Name'], result.contacts.phone.value,
      result.contacts.address.value, '', '', result.contacts.postcode.value || '', lead['Lead Proof URL']];
    const row = Object.fromEntries(VIEWER_HEADERS.map((name, i) => [name, values[i]]));
    Object.assign(row, { 'Lead Posting Date': result.freshness.timestamp,
      'Search Post ID': record.id, 'Search Run ID': record.cycle,
      'Phone Evidence URL': result.contacts.phone.sourceUrl,
      'Address Evidence URL': result.contacts.address.sourceUrl,
      'Validation Status': 'READY', 'Validated At': saved.validatedAt });
    // Identity is independent of payload changes: revalidation cannot silently
    // publish a second version. A correction needs an explicit reconciliation.
    const key = 'cot-delivery-' + createHash('sha256').update(JSON.stringify([config.endpoint, record.id])).digest('hex');
    const receipt = store.get(key);
    if (receipt) { counts[receipt.status === 'delivered' ? 'delivered' : 'blocked']++; continue; }
    counts.ready++;
    entries.push({ key, postId: record.id, row });
  }
  return { source: config.source, endpoint: config.endpoint, counts, entries };
}

export async function deliverReady(store, config, { now = Date.now, fetchFn = fetch, beforeSend = async () => {} } = {}) {
  if (!config.enabled) return { status: 'delivery_disabled' };
  if (!config.token || !config.queueReviewed) throw Error('DELIVERY_ACTIVATION_INCOMPLETE');
  if (!store.acquire()) return { status: 'delivery_busy' };
  try {
    const plan = deliveryPlan(store, config, now());
    let delivered = 0;
    // One row per transaction keeps ambiguous receipts isolated; bounded work
    // avoids monopolizing the controller lease or overwhelming the destination.
    for (const entry of plan.entries.slice(0, 3)) {
      await beforeSend();
      // Re-evaluate freshness after any preceding slow destination calls.
      if (!deliveryPlan(store, config, now()).entries.some(e => e.key === entry.key)) continue;
      store.set(entry.key, { status: 'sending', postId: entry.postId, at: now() });
      await store.flush?.();
      let receipt;
      try {
        const response = await fetchFn(config.endpoint, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json', 'Idempotency-Key': entry.key },
          body: JSON.stringify({ rows: [entry.row] }) });
        const data = await response.json();
        if (!response.ok || data.status !== 'COMPLETED' || data.records_received !== 1 || data.errors !== 0
          || !data.run_id || !Number.isInteger(data.records_inserted) || data.records_inserted < 0 || data.records_inserted > 1) {
          throw Error('DELIVERY_ACK_INVALID');
        }
        receipt = { status: 'delivered', postId: entry.postId, at: now(), runId: data.run_id,
          inserted: data.records_inserted, validationJobsCreated: data.validation_jobs_created ?? null };
      } catch {
        // Destination idempotency can retain a RUNNING/FAILED result. Never
        // interpret HTTP 200 alone as success or automatically replay ambiguity.
        store.set(entry.key, { status: 'uncertain', postId: entry.postId, at: now() });
        await store.flush?.();
        return { status: 'delivery_uncertain', delivered, postId: entry.postId };
      }
      store.set(entry.key, receipt);
      await store.flush?.();
      delivered++;
    }
    return { status: 'delivery_complete', delivered, counts: deliveryPlan(store, config, now()).counts };
  } finally { store.release(); }
}
