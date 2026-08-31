import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assess } from './records.mjs';
import { searchContactsFromLead } from '../src/search-author-contacts.js';

export const HEADERS = ['Post ID','Company Name','Lead Proof URL','Phone Number','Address 1','Post Code',
  'Phone Evidence URL','Address Evidence URL','AI Verdict','Output Status','Contact Status',
  'Proof Date','Validated At','Search Run ID','Reason'];

export function csvCell(value) {
  let s = String(value ?? '');
  // Quote escaping alone does not prevent spreadsheet formula execution.
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function csv(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

async function atomic(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

export async function exportFiles(store, directory, now) {
  await mkdir(directory, { recursive: true });
  const groups = { enriched: [], review: [], rejected: [] };
  for (const row of store.rows()) {
    if (row.status !== 'complete') continue;
    const lead = JSON.parse(row.lead); const saved = JSON.parse(row.result);
    // Reclassify freshness on every export; yesterday's GOOD is not today's fresh lead.
    const r = { ...assess(saved.response, now), validatedAt: saved.validatedAt };
    const c = r.contacts;
    const group = r.status === 'READY' ? 'enriched' : r.status === 'REJECTED' ? 'rejected' : 'review';
    groups[group].push([row.id, r.identity.status === 'matched' ? r.identity.businessName || lead['Company Name'] : lead['Company Name'], lead['Lead Proof URL'], c.phone.value, c.address.value,
      c.postcode.value, c.phone.sourceUrl, c.address.sourceUrl, r.verdict, r.status, c.status,
      r.freshness.timestamp, r.validatedAt, row.cycle, r.reason]);
  }
  for (const [name, rows] of Object.entries(groups)) await atomic(path.join(directory, `${name}.csv`), csv([HEADERS, ...rows]));
  // Separate source audit: extracted author values are never mixed into the
  // verified phone/address columns of the operational enriched.csv.
  const candidates = store.rows().flatMap(row => {
    const author = searchContactsFromLead(JSON.parse(row.lead));
    return author ? [[row.id, row.cycle, author.name, author.url, author.phone, author.address,
      author.email, author.website, author.contactSource, author.contactIdentityConfidence, 'UNVERIFIED_AUTHOR_CONTACT']] : [];
  });
  await atomic(path.join(directory, 'search-contacts.csv'), csv([
    ['Post ID','Search Run ID','Author','Author URL','Extracted Phone','Extracted Address','Email','Website','Phone Source Type','Source Identity Confidence','Verification Status'], ...candidates]));
  const runs = store.db.prepare('SELECT record FROM runs ORDER BY id').all().map(r => JSON.parse(r.record));
  await atomic(path.join(directory, 'runs.json'), JSON.stringify(runs, null, 2));
  const status = { generatedAt: new Date(now).toISOString(), counts: Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),
    stored: store.count(), pending: store.db.prepare("SELECT count(*) AS n FROM leads WHERE status='pending'").get().n,
    quarantined: store.db.prepare('SELECT count(*) AS n FROM quarantine').get().n,
    halted: store.get('halted'), cycle: store.get('cycle'), batch: store.get('batch'), lastTick: store.get('lastTick') };
  // Manifest is written last. All CSVs are regenerated from committed results;
  // a crash never appends duplicates or marks a not-yet-written row exported.
  await atomic(path.join(directory, 'status.json'), JSON.stringify(status, null, 2));
  return status;
}
