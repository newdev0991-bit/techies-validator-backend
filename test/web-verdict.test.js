import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWebChecks, normalizeWebChecks, parseWebVerdict, createWebVerdict,
  webVerdictEnabled, WEB_VERDICT_INSTRUCTIONS
} from '../src/web-verdict.js';

const MAP = 'https://maps.test/12-acacia-close';
const SITES = 'https://chain.test/our-stores';
const base = (over = {}) => ({ verdict: 'GOOD', reasoning: 'A new shop has opened.', red_flags: [], ...over });
const checks = (over = {}) => normalizeWebChecks({ premises_type: 'unknown', branch_count: null, is_chain: false, ...over });

test('a residential address found on the web becomes a hard rejection', () => {
  const out = applyWebChecks(
    base(),
    checks({ premises_type: 'residential', premises_evidence_url: MAP }),
    [{ url: MAP }]
  );
  assert.equal(out.verdict, 'BAD');
  assert.match(out.red_flags.join(' '), /residential_address/);
  assert.match(out.red_flags.join(' '), /maps\.test/);
  assert.match(out.reasoning, /private residence/);
});

test('ten or more sites, or a named chain, becomes a hard rejection', () => {
  const many = applyWebChecks(base(), checks({ branch_count: 14, branch_evidence_url: SITES }), [{ url: SITES }]);
  assert.equal(many.verdict, 'BAD');
  assert.match(many.red_flags.join(' '), /large_brand — 14 sites/);

  const chain = applyWebChecks(base(), checks({ is_chain: true, branch_evidence_url: SITES }), [{ url: SITES }]);
  assert.equal(chain.verdict, 'BAD');
  assert.match(chain.red_flags.join(' '), /a recognised chain/);

  // Nine sites is a small independent business under the spec, and must survive.
  const nine = applyWebChecks(base(), checks({ branch_count: 9, branch_evidence_url: SITES }), [{ url: SITES }]);
  assert.equal(nine.verdict, 'GOOD');
  assert.deepEqual(nine.red_flags, []);
});

test('a finding the model cannot point to in the tool’s citations does not bite', () => {
  // The rules are applied by this code, not by the model, and only on cited evidence.
  const uncited = applyWebChecks(
    base(), checks({ premises_type: 'residential', premises_evidence_url: MAP }), [{ url: 'https://elsewhere.test/' }]);
  assert.equal(uncited.verdict, 'GOOD', 'an uncited finding must not reject a lead');

  const noUrl = applyWebChecks(base(), checks({ premises_type: 'residential' }), [{ url: MAP }]);
  assert.equal(noUrl.verdict, 'GOOD');

  const noChainUrl = applyWebChecks(base(), checks({ branch_count: 40 }), [{ url: SITES }]);
  assert.equal(noChainUrl.verdict, 'GOOD');
});

test('unknown is a real answer and never an assumption', () => {
  assert.equal(normalizeWebChecks({}).premises_type, 'unknown');
  assert.equal(normalizeWebChecks({ premises_type: 'probably a house' }).premises_type, 'unknown');
  assert.equal(normalizeWebChecks({ branch_count: 'lots' }).branch_count, null);
  assert.equal(normalizeWebChecks({ branch_count: -3 }).branch_count, null);
  assert.equal(normalizeWebChecks({ is_chain: 'yes' }).is_chain, false, 'only a real boolean counts');

  const out = applyWebChecks(base(), checks(), []);
  assert.equal(out.verdict, 'GOOD', 'finding nothing must leave the verdict alone');
  assert.deepEqual(out.red_flags, []);
});

test('a commercial finding does not upgrade anything on its own', () => {
  const out = applyWebChecks(base({ verdict: 'MAYBE' }), checks({ premises_type: 'commercial', premises_evidence_url: MAP }), [{ url: MAP }]);
  assert.equal(out.verdict, 'MAYBE', 'the web may only apply the two exclusions, never promote a lead');
});

test('browsing is scoped to the two rules a scrape cannot settle', () => {
  assert.match(WEB_VERDICT_INSTRUCTIONS, /COMMERCIAL premises or a PRIVATE RESIDENCE/);
  assert.match(WEB_VERDICT_INSTRUCTIONS, /How many branches or sites/);
  // It must not become a second opinion on the event itself.
  assert.match(WEB_VERDICT_INSTRUCTIONS, /Do NOT use the web to decide whether an opening or relocation happened/);
  assert.match(WEB_VERDICT_INSTRUCTIONS, /Cite the page you read/);
});

test('the capability is on by default and takes any plain spelling of off', () => {
  assert.equal(webVerdictEnabled({}), true, 'unset means on');
  assert.equal(webVerdictEnabled({ WEB_VERDICT: 'on' }), true);
  for (const off of ['off', 'false', '0', 'no', 'OFF', ' False ', 'No'])
    assert.equal(webVerdictEnabled({ WEB_VERDICT: off }), false, `${JSON.stringify(off)} must disable it`);
  assert.equal(webVerdictEnabled({ WEB_VERDICT: 'maybe' }), true, 'unrecognised leaves it on');

  assert.equal(createWebVerdict({ env: {} }), null, 'no API key, no browsing');
  assert.equal(createWebVerdict({ env: { WEB_VERDICT: 'off', OPENAI_API_KEY: 'k' } }), null);
  assert.equal(typeof createWebVerdict({ env: { OPENAI_API_KEY: 'k' } }), 'function');
});

test('a provider failure yields null so the lead falls back to the plain call', async () => {
  const env = { OPENAI_API_KEY: 'k' };
  const http500 = createWebVerdict({ env, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(await http500('prompt', 'system'), null);

  const thrown = createWebVerdict({ env, fetchImpl: async () => { throw new Error('socket closed'); } });
  assert.equal(await thrown('prompt', 'system'), null);

  const garbage = createWebVerdict({ env, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [] }) }) });
  assert.equal(await garbage('prompt', 'system'), null, 'an unparseable body must not become a verdict');
});

test('the request carries the search tool and asks for the web_checks block', async () => {
  let sent;
  const verdict = createWebVerdict({
    env: { OPENAI_API_KEY: 'k' },
    fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text',
        text: `{"verdict":"BAD","reasoning":"Home address.","web_checks":{"premises_type":"residential","premises_evidence_url":"${MAP}"}}`,
        annotations: [{ type: 'url_citation', url: MAP, title: 'Map' }] }] }] }) }; }
  });
  const parsed = await verdict('LEAD DATA: ...', 'You are a strict formatter.');
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(sent.body.tools, [{ type: 'web_search' }]);
  assert.match(sent.body.input, /web_checks/);
  assert.match(sent.body.instructions, /You are a strict formatter/, 'the base system message is kept');
  assert.equal(parsed.webChecks.premises_type, 'residential');
  assert.deepEqual(parsed.citations, [{ url: MAP, title: 'Map' }]);
  assert.equal(parseWebVerdict({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'nope' }] }] }), null);
});
