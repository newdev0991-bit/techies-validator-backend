import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server.js';

const GENESIS_GROUP_URL =
  'https://www.facebook.com/groups/689239672413863/?multi_permalinks=1760741248597028&hoisted_section_header_type=recently_seen';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function modelAssessment() {
  return {
    verdict: 'BAD',
    reasoning: 'The page has many historical posts.',
    confidence: 80,
    key_factors: ['Established page'],
    red_flags: ['High post count'],
    opportunity_score: 30,
    recommended_action: 'Review before outreach.',
    caption_analysis: {
      has_opening_keywords: true,
      has_relocation_keywords: false,
      has_ownership_keywords: false,
      has_minor_update_keywords: false,
      summary: 'The caption announces an opening.'
    },
    post_history_analysis: {
      total_posts: 142,
      page_maturity: 'established',
      posting_pattern: 'Long history',
      assessment: 'Existing page'
    }
  };
}

test('HTTP analyze preserves legacy envelope and enforces reconciled freshness policy', async t => {
  let upstreamMode = 'valid';
  const upstream = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (upstreamMode === 'invalid') {
      res.end(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }));
      return;
    }
    if (upstreamMode === 'slow-body') {
      res.flushHeaders();
      setTimeout(() => {
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(modelAssessment()) } }]
        }));
      }, 1_500);
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAssessment()) } }]
    }));
  });
  const upstreamAddress = await listen(upstream);
  const api = http.createServer(app);
  const apiAddress = await listen(api);
  t.after(async () => {
    await close(api);
    await close(upstream);
  });

  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstreamAddress.port}`;
  process.env.LEAD_DATE_ORDER = 'MDY';
  const apiUrl = `http://127.0.0.1:${apiAddress.port}`;

  const genesisResponse = await fetch(`${apiUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      lead: {
        'Company Name': 'Genesis Cannock',
        'Lead Proof URL': GENESIS_GROUP_URL,
        'Lead Posting Date': '08/06/2026',
        fetchResults: {
          rawData: {
            status: 'success',
            posted_at_iso: '2026-08-04T05:49:00.000Z',
            posted_at_raw: '04/08/2026',
            postDate: '04/08/2026',
            postUrl: GENESIS_GROUP_URL
          }
        }
      }
    })
  });
  assert.equal(genesisResponse.status, 200);
  const legacyEnvelope = await genesisResponse.json();
  assert.ok(Array.isArray(legacyEnvelope.content));
  assert.equal(typeof legacyEnvelope.content[0].text, 'string');
  const genesis = JSON.parse(legacyEnvelope.content[0].text);
  assert.equal(genesis.verdict, 'UNCLEAR');
  assert.equal(genesis.needs_manual_review, true);
  assert.equal(genesis.posted_at, null);
  assert.equal(genesis.freshness.reasonCode, 'DATE_CONFLICT');
  assert.equal(genesis.freshness.autoRejectEligible, false);
  assert.equal(genesis.post_history_analysis.total_posts, null);
  assert.equal(genesis.post_history_analysis.page_maturity, 'unknown');
  assert.doesNotMatch(genesis.reasoning, /AUTO REJECTED/);

  const staleResponse = await fetch(`${apiUrl}/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      lead: {
        'Company Name': 'Trusted stale lead',
        'Lead Proof URL': 'https://www.facebook.com/example/posts/123',
        fetchResults: {
          rawData: {
            status: 'success',
            scrape: { success: true },
            posted_at_iso: '2020-01-01T00:00:00.000Z',
            postUrl: 'https://www.facebook.com/example/posts/123',
            time_target_matched: true,
            time_confidence: 'high',
            time_target_match_method: 'direct_post_url',
            time_precision: 'exact',
            time_is_estimated: false
          }
        }
      }
    })
  });
  assert.equal(staleResponse.status, 200);
  const stale = JSON.parse((await staleResponse.json()).content[0].text);
  assert.equal(stale.verdict, 'BAD');
  assert.equal(stale.freshness.autoRejectEligible, true);
  assert.match(stale.reasoning, /^\[AUTO REJECTED:/);

  const invalidPayload = await fetch(`${apiUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lead: [] })
  });
  assert.equal(invalidPayload.status, 400);
  assert.deepEqual(await invalidPayload.json(), {
    error: {
      code: 'INVALID_LEAD',
      message: 'The "lead" field must be a JSON object.'
    }
  });

  const invalidJson = await fetch(`${apiUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json'
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON');

  upstreamMode = 'invalid';
  const badProvider = await fetch(`${apiUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lead: { 'Company Name': 'Bad provider response' } })
  });
  assert.equal(badProvider.status, 502);
  assert.deepEqual(await badProvider.json(), {
    error: {
      code: 'INVALID_OPENAI_RESPONSE',
      message: 'Lead analysis provider returned an invalid response.'
    }
  });

  upstreamMode = 'slow-body';
  process.env.OPENAI_TIMEOUT_MS = '1000';
  const timedOutProvider = await fetch(`${apiUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lead: { 'Company Name': 'Slow provider response' } })
  });
  assert.equal(timedOutProvider.status, 504);
  assert.deepEqual(await timedOutProvider.json(), {
    error: {
      code: 'OPENAI_TIMEOUT',
      message: 'Lead analysis timed out. Please try again.'
    }
  });
});
