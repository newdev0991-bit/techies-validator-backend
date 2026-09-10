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

test('the capability is off by default and takes any plain spelling of on', () => {
  assert.equal(webContactRecoveryEnabled({}), false, 'unset means off');
  // Whichever spelling of "on" an operator reaches for must actually enable it.
  for (const on of ['on', 'true', '1', 'yes', 'ON', ' True ', 'Yes'])
    assert.equal(webContactRecoveryEnabled({ WEB_CONTACT_RECOVERY: on }), true, `${JSON.stringify(on)} must enable it`);
  for (const off of ['off', 'false', '0', 'no'])
    assert.equal(webContactRecoveryEnabled({ WEB_CONTACT_RECOVERY: off }), false, `${JSON.stringify(off)} stays off`);
  // Anything unrecognised stays off rather than silently turning on paid recovery.
  assert.equal(webContactRecoveryEnabled({ WEB_CONTACT_RECOVERY: 'maybe' }), false);

  assert.equal(createWebContactSearch({ env: {} }), null, 'off by default, no search');
  assert.equal(createWebContactSearch({ env: { WEB_CONTACT_RECOVERY: 'on' } }), null, 'no API key, no search');
  assert.equal(createWebContactSearch({ env: { WEB_CONTACT_RECOVERY: 'off', OPENAI_API_KEY: 'k' } }), null);
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

// Response shapes captured from real /v1/responses calls on 2026-09-10. Reduced to the
// fields the code reads, but the STRUCTURE is verbatim -- in particular `annotations`
// really does come back empty when the reply is a bare JSON object, which is what we
// ask for. Reading citations only from annotations therefore discarded every result.
const liveResponse = (openedUrls, json) => ({
  output: [
    { type: 'reasoning', summary: [] },
    ...openedUrls.map(url => ({ type: 'web_search_call', status: 'completed',
      action: { type: 'open_page', url } })),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: json, annotations: [] }] }
  ]
});

test('a bare-JSON reply still yields provenance, from the pages the tool opened', () => {
  // gpt-5.6-terra, verbatim: opened the page it went on to cite.
  const payload = liveResponse(
    ['https://catalogue.royalalberthall.com/'],
    '{"phone":"020 7589 8212","sourceUrl":"https://catalogue.royalalberthall.com/","isBranchSpecific":true,"notes":"Box Office"}'
  );
  const parsed = parseRecovery(payload);
  assert.deepEqual(parsed.citations.map(c => c.url), ['https://catalogue.royalalberthall.com/'],
    'annotations are empty here; provenance has to come from the open_page actions');
  assert.ok(parsed.citations.some(c => c.url === parsed.sourceUrl), 'the claimed source must verify');
});

test('a source the model never opened is caught, on real captured responses', async () => {
  // gpt-5.5, verbatim: cited a contact page, but the only page it opened was an
  // unrelated PDF about carol concerts. The number happened to be right; the source
  // was not one it had read.
  const invented = liveResponse(
    ['https://d117kfg112vbe4.cloudfront.net/public/Royal-Albert-Hall-DAMS/Website-Documents/Carols.pdf'],
    '{"phone":"020 7589 8212","sourceUrl":"https://catalogue.royalalberthall.com/contact.aspx","isBranchSpecific":true,"notes":""}'
  );
  const row1 = row();
  await runWebContactRecovery([row1], { search: async () => parseRecovery(invented) });
  assert.deepEqual(row1.analysis.contact_enrichment.phone.candidates, [],
    'a number whose source the model never opened must not reach a reviewer');
  assert.equal(row1.analysis.contact_lookup.webRecovery.discarded, 'source_not_in_citations');

  // gpt-5.4, verbatim: opened NO page at all, answered from search snippets, cited the
  // charity register, and produced a different number.
  const unopened = liveResponse([],
    '{"phone":"020 7959 0505","sourceUrl":"https://register-of-charities.charitycommission.gov.uk/en/charity-search/-/charity-details/254543/contact-information","isBranchSpecific":true,"notes":""}'
  );
  const row2 = row();
  await runWebContactRecovery([row2], { search: async () => parseRecovery(unopened) });
  assert.deepEqual(row2.analysis.contact_enrichment.phone.candidates, []);
  assert.equal(row2.analysis.contact_lookup.webRecovery.discarded, 'source_not_in_citations');
});
