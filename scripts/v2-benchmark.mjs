#!/usr/bin/env node
// Techies Validation Benchmark v1 (plan tasks 3, 7, 8, 9).
//
// Runs the v2 validator over a LABELED dataset and reports recall, precision,
// review rate, deal recall, cost / 1,000 and latency — per model configuration,
// on exactly the same leads.
//
// Usage:
//   node scripts/v2-benchmark.mjs data/benchmark.csv \
//     --configs "gpt-5-nano;gpt-5-mini;gpt-5-nano,gpt-5-mini" [--limit 200] [--out report.json]
//
// Dataset (CSV or JSONL). Required columns:
//   label        GOOD | BAD | REVIEW   (the human truth for "is this a real COT opportunity")
//   Post Caption the Facebook post text (or a fetchResults JSON column)
// Optional: deal (true/1 when the lead became a deal), v1_verdict (old validator's
// verdict, to score the current system on the same rows), and any lead fields
// (Company Name, Industry Type, Post Code, Phone Number, ...).
import { readFile, writeFile } from 'node:fs/promises';
import 'dotenv/config';
import { runRules, captionOf } from '../src/v2/rules.js';
import { classifyEvent } from '../src/v2/event-classifier.js';

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(Boolean));
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

export async function loadDataset(file) {
  const text = await readFile(file, 'utf8');
  const rows = file.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map(l => JSON.parse(l)) : parseCsv(text);
  return rows.map(r => {
    const lead = { ...r };
    if (typeof r.fetchResults === 'string' && r.fetchResults.trim().startsWith('{')) lead.fetchResults = JSON.parse(r.fetchResults);
    return {
      lead,
      label: String(r.label || '').trim().toUpperCase(),
      deal: /^(?:true|1|yes|y)$/i.test(String(r.deal || '')),
      v1: String(r.v1_verdict || '').trim().toUpperCase() || null
    };
  }).filter(x => ['GOOD', 'BAD', 'REVIEW'].includes(x.label));
}

// Predicted "positive" = would be sent toward delivery (PASS / GOOD).
export function score(items) {
  const n = items.length;
  const pos = items.filter(i => i.label === 'GOOD');
  const tp = items.filter(i => i.label === 'GOOD' && i.pred === 'PASS').length;
  const fp = items.filter(i => i.label === 'BAD' && i.pred === 'PASS').length;
  const fn = items.filter(i => i.label === 'GOOD' && i.pred === 'FAIL').length; // lost real leads
  const deals = items.filter(i => i.deal);
  const dealsKept = deals.filter(i => i.pred !== 'FAIL').length;
  const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
  return {
    n,
    recall: pct(tp, pos.length),                     // GOOD leads auto-passed
    recall_incl_review: pct(pos.filter(i => i.pred !== 'FAIL').length, pos.length), // not lost
    precision: pct(tp, tp + fp),
    false_negatives: fn,
    false_positives: fp,
    review_rate: pct(items.filter(i => i.pred === 'UNCERTAIN').length, n),
    deal_recall: pct(dealsKept, deals.length),
    stage1_rejects: items.filter(i => i.stage1 === 'REJECT').length,
    cost_per_1000_usd: n ? +(1000 * items.reduce((s, i) => s + (i.cost || 0), 0) / n).toFixed(4) : null,
    avg_latency_ms: n ? Math.round(items.reduce((s, i) => s + (i.latency || 0), 0) / n) : null,
    escalated: items.filter(i => (i.steps || 0) > 1).length
  };
}

// Accepts analysis verdicts (GOOD/BAD/...) or pipeline statuses (READY/REJECTED/...).
export function v1AsPred(v) {
  if (['GOOD', 'READY'].includes(v)) return 'PASS';
  if (['BAD', 'NOT_A_LEAD', 'REJECTED', 'EXPIRED'].includes(v)) return 'FAIL';
  return v ? 'UNCERTAIN' : null;
}

async function runConfig(data, models, concurrency) {
  const out = new Array(data.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < data.length) {
      const idx = cursor++; const d = data[idx];
      const rules = runRules(d.lead);
      let pred = rules.decision === 'REJECT' ? 'FAIL' : 'UNCERTAIN'; let cost = 0; let latency = 0; let steps = 0; let event = null;
      if (rules.decision === 'CONTINUE') {
        const r = await classifyEvent(captionOf(d.lead), rules.facts, { models });
        pred = r.decision; cost = r.totalCostUsd; steps = r.steps.length; event = r.classification?.event_type;
        latency = r.steps.reduce((s, x) => s + (x.latencyMs || 0), 0);
      }
      out[idx] = { ...d, pred, cost, latency, steps, event, stage1: rules.decision, stage1Reasons: rules.reasons };
    }
  }));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  if (!file) { console.error('usage: v2-benchmark.mjs <dataset.csv|jsonl> [--configs a;b,c] [--limit N] [--out f]'); process.exit(2); }
  let data = await loadDataset(file);
  if (opt('limit')) data = data.slice(0, Number(opt('limit')));
  const configs = (opt('configs') || 'gpt-5-nano;gpt-5-mini;gpt-5-nano,gpt-5-mini').split(';').map(c => c.split(','));
  const report = { dataset: file, n: data.length, at: new Date().toISOString(), results: {} };

  const v1 = data.filter(d => d.v1).map(d => ({ ...d, pred: v1AsPred(d.v1) }));
  if (v1.length) report.results['current-validator (v1_verdict column)'] = score(v1);

  const detail = {};
  for (const models of configs) {
    const name = `rules + ${models.join(' -> ')}`;
    const items = await runConfig(data, models, Number(opt('concurrency')) || 3);
    report.results[name] = score(items);
    report.rows = report.rows || {};
    report.rows[name] = items.map(i => ({ company: i.lead['Company Name'], v1: i.v1, pred: i.pred, event: i.event,
      stage1: i.stage1Reasons, steps: i.steps, cost: i.cost }));
    detail[name] = items.filter(i => (i.label === 'GOOD' && i.pred === 'FAIL') || (i.label === 'BAD' && i.pred === 'PASS'))
      .map(i => ({ company: i.lead['Company Name'], label: i.label, pred: i.pred, event: i.event, stage1: i.stage1Reasons,
        caption: captionOf(i.lead).slice(0, 200) }));
  }
  console.table(report.results);
  report.errors = detail;
  if (opt('out')) await writeFile(opt('out'), JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
