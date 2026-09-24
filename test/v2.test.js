import test from 'node:test';
import assert from 'node:assert/strict';
import { runRules } from '../src/v2/rules.js';
import { classifyEvent, decide, parseClassification, costUsd } from '../src/v2/event-classifier.js';
import { validateLeadV2, deliveryStatus, legacyVerdict } from '../src/v2/validate.js';
import { attachShadowV2 } from '../src/v2/shadow.js';
import { score } from '../scripts/v2-benchmark.mjs';
import { compare, parseShadowLines } from '../scripts/v2-compare-shadow.mjs';

const lead = (caption, extra = {}) => ({
  'Company Name': 'Bean There Cafe', 'Industry Type': 'Cafe',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'M20 6RL',
  fetchResults: { rawData: { postText: caption } }, ...extra
});

function fakeFetch(answers) {
  const calls = [];
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const content = answers[body.model];
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 } }) };
  };
  fn.calls = calls;
  return fn;
}

test('stage 1 rejects only high-certainty exclusions', () => {
  assert.equal(runRules(lead('Grand opening Saturday!', { 'Post Code': 'BT1 1AA',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'BT1 1AA' })).decision, 'REJECT');
  assert.equal(runRules(lead('Now open!', { 'Industry Type': 'Primary School' })).reasons[0], 'prohibited_industry:education');
  assert.equal(runRules(lead('Now open!', { 'Company Name': 'Greggs' })).reasons[0], 'known_chain');
  assert.equal(runRules(lead('We are hiring! Apply for the role today')).decision, 'REJECT');
  // Minor-update wording is a FACT, never a rejection on its own (recall).
  const r = runRules(lead('Check out our new menu'));
  assert.equal(r.decision, 'CONTINUE');
  assert.equal(r.facts.has_minor_update_keywords, true);
  assert.equal(r.facts.page_maturity, 'unknown');
  assert.equal(runRules(lead('')).decision, 'NEEDS_EVIDENCE');
});

test('code decides PASS/FAIL/UNCERTAIN and rejects invented quotes', () => {
  const caption = 'We have moved to our new premises on Oak Road';
  const c = parseClassification(JSON.stringify({ event_type: 'relocation', about: 'self', confidence: 90,
    evidence_quote: 'moved to our new premises' }));
  assert.equal(decide(c, caption), 'PASS');
  assert.equal(decide({ ...c, evidence_quote: 'opening a second shop' }, caption), 'UNCERTAIN');
  assert.equal(decide({ ...c, confidence: 50 }, caption), 'UNCERTAIN');
  assert.equal(decide({ ...c, event_type: 'minor_update', evidence_quote: '' }, caption), 'FAIL');
  assert.equal(decide(parseClassification('not json'), caption), 'UNCERTAIN');
  assert.equal(costUsd('gpt-5-nano', { prompt_tokens: 1e6, completion_tokens: 1e6 }), 0.45);
});

test('escalates nano -> mini only when uncertain', async () => {
  const caption = 'So excited, we finally got the keys!!';
  const fetchImpl = fakeFetch({
    'gpt-5-nano': { event_type: 'ambiguous', about: 'self', confidence: 40 },
    'gpt-5-mini': { event_type: 'new_opening', about: 'self', confidence: 85, evidence_quote: 'we finally got the keys' }
  });
  const r = await classifyEvent(caption, { company_name: 'X' }, { fetchImpl, apiKey: 'k', models: ['gpt-5-nano', 'gpt-5-mini'] });
  assert.deepEqual(fetchImpl.calls.map(c => c.model), ['gpt-5-nano', 'gpt-5-mini']);
  assert.equal(r.decision, 'PASS');
  assert.equal(r.decidedBy, 'gpt-5-mini');
  assert.equal(fetchImpl.calls[0].max_completion_tokens > 0 && fetchImpl.calls[0].temperature, undefined);

  const confident = fakeFetch({ 'gpt-5-nano': { event_type: 'minor_update', about: 'self', confidence: 95 } });
  const r2 = await classifyEvent('New menu out now', { company_name: 'X' }, { fetchImpl: confident, apiKey: 'k', models: ['gpt-5-nano', 'gpt-5-mini'] });
  assert.equal(confident.calls.length, 1);
  assert.equal(r2.decision, 'FAIL');
});

test('stage 1 rejects never call the model', async () => {
  const fetchImpl = fakeFetch({});
  const r = await validateLeadV2(lead('Now open', { 'Company Name': 'Starbucks' }), { fetchImpl, apiKey: 'k' });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(r.statuses.eligibility, 'INELIGIBLE');
  assert.equal(r.verdict, 'BAD');
  assert.equal(r.costUsd, 0);
});

test('missing phone is NOT_READY, not BAD', () => {
  const s = { opportunity: 'QUALIFIED', identity: 'VERIFIED', eligibility: 'ELIGIBLE', contact: 'PHONE_MISSING' };
  s.delivery = deliveryStatus({ ...s, freshness: { decision: 'fresh' }, requireFresh: true });
  assert.equal(s.delivery, 'NOT_READY');
  assert.equal(legacyVerdict(s), 'GOOD');
});

test('shadow mode is off by default and never changes v1 or throws', async () => {
  const v1 = { verdict: 'GOOD' };
  assert.equal(await attachShadowV2(lead('x'), v1, { env: {} }), v1);
  const log = console.log; console.log = () => {};
  try {
    const out = await attachShadowV2(lead('x'), v1, { env: { VALIDATOR_V2_SHADOW: 'on' }, run: async () => { throw new Error('boom'); } });
    assert.equal(out.verdict, 'GOOD');
    const ok = await attachShadowV2(lead('x'), v1, { env: { VALIDATOR_V2_SHADOW: 'on' }, run: async () => ({ verdict: 'BAD', statuses: {} }) });
    assert.equal(ok.verdict, 'GOOD');
    assert.equal(ok.shadow_v2.verdict, 'BAD');
  } finally { console.log = log; }
});

test('benchmark scoring and shadow comparison', () => {
  const s = score([
    { label: 'GOOD', pred: 'PASS', deal: true, cost: 0.0001 }, { label: 'GOOD', pred: 'FAIL', deal: true },
    { label: 'BAD', pred: 'PASS' }, { label: 'BAD', pred: 'FAIL' }, { label: 'REVIEW', pred: 'UNCERTAIN' }]);
  assert.equal(s.recall, 50); assert.equal(s.precision, 50); assert.equal(s.deal_recall, 50); assert.equal(s.review_rate, 20);
  const recs = parseShadowLines([
    'INFO [shadow-v2] {"leadKey":"a","v1":{"verdict":"GOOD"},"v2":{"verdict":"GOOD"}}',
    '[shadow-v2] {"leadKey":"b","v1":{"verdict":"GOOD"},"v2":{"verdict":"BAD","costUsd":0.0002}}',
    'unrelated line'].join('\n'));
  const c = compare(recs);
  assert.equal(c.total, 2); assert.equal(c.agreement_pct, 50); assert.equal(c.buckets['OLD GOOD / NEW BAD'], 1);
});
