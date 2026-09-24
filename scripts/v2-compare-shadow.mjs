#!/usr/bin/env node
// Plan task 15: compare OLD vs NEW decisions recorded by shadow mode.
//
// Input: Render log export (lines containing "[shadow-v2] {...}") or the
// V2_SHADOW_LOG_PATH JSONL file. Output: agreement table + the disagreement
// buckets to inspect by hand (especially anything that became a deal).
//
//   node scripts/v2-compare-shadow.mjs render-logs.txt [--out disagreements.csv]
import { readFile, writeFile } from 'node:fs/promises';

export function parseShadowLines(text) {
  return text.split('\n').map(line => {
    const i = line.indexOf('{');
    if (i < 0 || (!line.includes('[shadow-v2]') && i !== 0)) return null;
    try { return JSON.parse(line.slice(i)); } catch { return null; }
  }).filter(r => r && r.v1 && r.v2);
}

const bucketOf = r => `OLD ${r.v1.verdict} / NEW ${r.v2.verdict}`;

export function compare(records) {
  const seen = new Map();
  for (const r of records) seen.set(r.leadKey || JSON.stringify(r), r); // latest per lead
  const rows = [...seen.values()];
  const buckets = {};
  for (const r of rows) (buckets[bucketOf(r)] ||= []).push(r);
  const agree = rows.filter(r => r.v1.verdict === r.v2.verdict).length;
  return {
    total: rows.length,
    agreement_pct: rows.length ? +(100 * agree / rows.length).toFixed(1) : null,
    v2_cost_usd: +rows.reduce((s, r) => s + (r.v2.costUsd || 0), 0).toFixed(4),
    v2_stage1_rejects: rows.filter(r => r.v2.stage1 === 'REJECT').length,
    v2_escalated_to_mini: rows.filter(r => /mini/.test(r.v2.decidedBy || '')).length,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    disagreements: rows.filter(r => r.v1.verdict !== r.v2.verdict)
  };
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: v2-compare-shadow.mjs <logs> [--out file.csv]'); process.exit(2); }
  const res = compare(parseShadowLines(await readFile(file, 'utf8')));
  const { disagreements, ...summary } = res;
  console.log(JSON.stringify(summary, null, 2));
  const outIdx = rest.indexOf('--out');
  if (outIdx >= 0) {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['bucket,company,leadKey,v1,v2,opportunity,identity,contact,delivery,event,stage1_reasons,caption,human_label']
      .concat(disagreements.map(r => [bucketOf(r), r.company, r.leadKey, r.v1.verdict, r.v2.verdict, r.v2.statuses?.opportunity,
        r.v2.statuses?.identity, r.v2.statuses?.contact, r.v2.statuses?.delivery, r.v2.event,
        (r.v2.stage1_reasons || []).join('|'), r.caption, ''].map(esc).join(',')));
    await writeFile(rest[outIdx + 1], lines.join('\n'));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
