import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebContactRecovery, recoveryTarget } from '../src/web-contact-recovery.js';
import { createWebContactSearch, parseRecovery, citationsFrom, webContactRecoveryEnabled } from '../src/openai-web-search.js';

const SOURCE = 'https://synthetic-makers.test/contact';

function row(overrides = {}) {
  const { identity = {}, phone = '', freshness = {}, verdict = 'GOOD', company = 'Synthetic Publisher' } = overrides;
  return {
    lead: { 'Company Name': company },
    analysis: {
      contact_lookup: { status: 'complete', required: ['phone', 'address'] },
      freshness: { decision: 'stale', requiresManualReview: false, ...freshness },
      quality_assessment: {
        verdict,
        business_identity: { businessName: 'Synthetic Makers', relationship: 'self', locationQuote: 'Taunton', ...identity }
      },
      contact_enrichment: {
        status: phone ? 'partial' : 'unavailable',
        requiresManualReview: !phone,
        reviewReasons: phone ? [] : ['PHONE_MISSING'],
        phone: { value: phone, candidates: [] },
        address: { value: '', candidates: [] }
      }
    }
  };
}

const found = (over = {}) => ({ phone: '01823 550134', sourceUrl: SOURCE, isBranchSpecific: true,
  citations: [{ url: SOURCE, title: 'Contact' }], ...over });

test('a recovered number is a traceable candidate and never a verified contact', async () => {
  const lead = row();
  await runWebContactRecovery([lead], { search: async () => found() });

  const contacts = lead.analysis.contact_enrichment;
  assert.equal(contacts.phone.value, '', 'web search must never write a contact value');
  assert.equal(contacts.status, 'unavailable', 'it must not change the contact status');
  assert.equal(contacts.requiresManualReview, true);
  assert.deepEqual(contacts.reviewReasons, ['PHONE_MISSING']);

  const [candidate] = contacts.phone.candidates;
  assert.equal(candidate.value, '01823550134');
  assert.equal(candidate.source, 'web-search');
  assert.equal(candidate.sourceUrl, SOURCE);
  assert.equal(candidate.verified, false);
  assert.equal(candidate.callTested, false);
  assert.equal(candidate.branchSpecific, true);
  assert.equal(lead.analysis.contact_lookup.webRecovery.status, 'web_recovery_candidate');
  // The Actor's own result is kept alongside, not replaced.
  assert.equal(lead.analysis.contact_lookup.status, 'complete');
});

test('a number the model cannot point to in the tool’s own citations is discarded', async () => {
  // The model names a source it never opened. Citations come from the search tool, not
  // from model prose, so this is checkable rather than a matter of trust.
  const uncited = row();
  await runWebContactRecovery([uncited], { search: async () => found({ citations: [{ url: 'https://elsewhere.test/' }] }) });
  assert.deepEqual(uncited.analysis.contact_enrichment.phone.candidates, []);
  assert.equal(uncited.analysis.contact_lookup.webRecovery.discarded, 'source_not_in_citations');

  const noUrl = row();
  await runWebContactRecovery([noUrl], { search: async () => found({ sourceUrl: '' }) });
  assert.deepEqual(noUrl.analysis.contact_enrichment.phone.candidates, []);
  assert.equal(noUrl.analysis.contact_lookup.webRecovery.discarded, 'number_without_source');

  const junk = row();
  await runWebContactRecovery([junk], { search: async () => found({ phone: 'call us!' }) });
  assert.deepEqual(junk.analysis.contact_enrichment.phone.candidates, []);
});

test('a central or head-office line is surfaced as such rather than passed off as the branch', async () => {
  const lead = row();
  await runWebContactRecovery([lead], { search: async () => found({ isBranchSpecific: false }) });
  const [candidate] = lead.analysis.contact_enrichment.phone.candidates;
  assert.equal(candidate.branchSpecific, false);
  assert.equal(lead.analysis.contact_lookup.webRecovery.branchSpecific, false);
});

test('only leads that need a lookup, and are ours to look up, get one', async () => {
  const cases = [
    ['already has a verified phone', row({ phone: '01632960123' })],
    ['not a GOOD opportunity', row({ verdict: 'UNCLEAR' })],
    ['promotes a different business', row({ identity: { relationship: 'third_party' } })],
    ['proof cannot be placed in time', row({ freshness: { requiresManualReview: true } })]
  ];
  for (const [why, lead] of cases) {
    assert.equal(recoveryTarget(lead), '', `${why}: should not be searched`);
    await runWebContactRecovery([lead], { search: async () => assert.fail(`${why}: must not spend a search`) });
  }
  // And the business searched for is the one the post is about, not the publisher.
  assert.equal(recoveryTarget(row()), 'Synthetic Makers');
});

test('the paid lookup is capped per batch and a failure never becomes a retry', async () => {
  const leads = [row(), row(), row()];
  let calls = 0;
  await runWebContactRecovery(leads, { maxLookups: 2, search: async () => { calls++; return found(); } });
  assert.equal(calls, 2, 'the budget must bound the number of paid searches');
  assert.equal(leads[2].analysis.contact_lookup.webRecovery.status, 'web_recovery_budget_exhausted');

  const failing = row();
  let attempts = 0;
  await runWebContactRecovery([failing], { search: async () => { attempts++; throw new Error('provider down'); } });
  assert.equal(attempts, 1, 'a charged call must not be retried automatically');
  assert.equal(failing.analysis.contact_lookup.webRecovery.status, 'web_recovery_failed');
});

test('the capability is off unless switched on, and needs a key', () => {
  assert.equal(webContactRecoveryEnabled({}), false);
  assert.equal(webContactRecoveryEnabled({ WEB_CONTACT_RECOVERY: 'true' }), false, 'only the exact value arms it');
  assert.equal(webContactRecoveryEnabled({ WEB_CONTACT_RECOVERY: 'on' }), true);
  assert.equal(createWebContactSearch({ env: {} }), null);
  assert.equal(createWebContactSearch({ env: { WEB_CONTACT_RECOVERY: 'on' } }), null, 'no API key, no search');
  assert.equal(typeof createWebContactSearch({ env: { WEB_CONTACT_RECOVERY: 'on', OPENAI_API_KEY: 'k' } }), 'function');
});

test('the Responses payload is read for citations and the model’s JSON', () => {
  const payload = {
    output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text',
        text: `Here you go. {"phone":"01823 550134","sourceUrl":"${SOURCE}","isBranchSpecific":true,"notes":"From the contact page."}`,
        annotations: [{ type: 'url_citation', url: SOURCE, title: 'Contact' },
                      { type: 'url_citation', url: 'https://directory.test/synthetic', title: 'Directory' }] }] }
    ]
  };
  assert.deepEqual(citationsFrom(payload).map(c => c.url), [SOURCE, 'https://directory.test/synthetic']);
  const parsed = parseRecovery(payload);
  assert.equal(parsed.phone, '01823 550134');
  assert.equal(parsed.sourceUrl, SOURCE);
  assert.equal(parsed.isBranchSpecific, true);
  assert.equal(parsed.citations.length, 2);
  assert.equal(parseRecovery({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no json here' }] }] }), null);
});

test('the request asks for web search and carries no lead data beyond the business', async () => {
  let sent;
  const search = createWebContactSearch({
    env: { WEB_CONTACT_RECOVERY: 'on', OPENAI_API_KEY: 'k' },
    fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ output: [] }) }; }
  });
  await search('Synthetic Makers', { location: 'Taunton' });
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(sent.body.tools, [{ type: 'web_search' }]);
  assert.match(sent.body.input, /Synthetic Makers/);
  assert.match(sent.body.input, /Taunton/);
  assert.match(sent.body.instructions, /never return a number you cannot point to a source for/i);
});
