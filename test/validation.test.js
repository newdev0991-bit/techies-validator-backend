import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidProviderResponseError,
  isSuccessfulFacebookScrape,
  normalizeAiResponse,
  validateFacebookUrl,
  validateKnownDuplicateKeys,
  validateLeadRequestBody
} from '../src/validation.js';

test('validates lead request payload shape', () => {
  assert.equal(validateLeadRequestBody(null).error.code, 'INVALID_REQUEST_BODY');
  assert.equal(validateLeadRequestBody({ lead: [] }).error.code, 'INVALID_LEAD');
  assert.equal(validateLeadRequestBody({ lead: {} }).error.code, 'EMPTY_LEAD');
  assert.deepEqual(validateLeadRequestBody({ lead: { Name: 'A' } }), {
    ok: true,
    lead: { Name: 'A' }
  });
});

test('accepts only credential-free Facebook HTTP(S) proof URLs', () => {
  assert.equal(validateFacebookUrl('not a url').error.code, 'INVALID_FACEBOOK_URL');
  assert.equal(validateFacebookUrl('https://example.com/post').error.code, 'INVALID_FACEBOOK_URL');
  assert.equal(
    validateFacebookUrl('https://user:pass@facebook.com/post').error.code,
    'INVALID_FACEBOOK_URL'
  );
  assert.equal(
    validateFacebookUrl('https://m.facebook.com/example/posts/1').ok,
    true
  );
});

test('claims Facebook scraping success only from an explicit successful actor result', () => {
  assert.equal(isSuccessfulFacebookScrape(null), false);
  assert.equal(isSuccessfulFacebookScrape({ status: 'success' }), false);
  assert.equal(isSuccessfulFacebookScrape({ scrape: { success: true } }), false);
  assert.equal(
    isSuccessfulFacebookScrape({ status: 'SUCCESS', scrape: { success: true } }),
    true
  );
  assert.equal(
    isSuccessfulFacebookScrape({ status: 'success', scrape: { success: false } }),
    false
  );
});

test('normalizes the AI response to the promised schema', () => {
  const normalized = normalizeAiResponse({
    verdict: 'good',
    reasoning: '  Useful lead  ',
    confidence: '101',
    key_factors: 'Opening announcement',
    red_flags: null,
    opportunity_score: -4,
    caption_analysis: { has_opening_keywords: true },
    post_history_analysis: { total_posts: '142', page_maturity: 'ESTABLISHED' }
  });
  assert.equal(normalized.verdict, 'GOOD');
  assert.equal(normalized.confidence, 100);
  assert.equal(normalized.opportunity_score, 0);
  assert.deepEqual(normalized.key_factors, ['Opening announcement']);
  assert.equal(normalized.caption_analysis.has_opening_keywords, true);
  assert.equal(normalized.post_history_analysis.total_posts, 142);
  assert.equal(normalized.post_history_analysis.page_maturity, 'established');
});

test('normalizes absent post history to null and unknown', () => {
  const normalized = normalizeAiResponse({ verdict: 'UNCLEAR' });
  assert.equal(normalized.post_history_analysis.total_posts, null);
  assert.equal(normalized.post_history_analysis.page_maturity, 'unknown');
});

test('rejects non-object provider responses', () => {
  assert.throws(
    () => normalizeAiResponse([]),
    error => error instanceof InvalidProviderResponseError
  );
});

test('validates duplicate key arrays and applies a size bound', () => {
  assert.deepEqual(validateKnownDuplicateKeys(undefined), { ok: true, value: [] });
  assert.equal(validateKnownDuplicateKeys('x').error.code, 'INVALID_DUPLICATE_KEYS');
  assert.equal(validateKnownDuplicateKeys([1]).error.code, 'INVALID_DUPLICATE_KEYS');
  assert.deepEqual(validateKnownDuplicateKeys(['a']), { ok: true, value: ['a'] });
});

test('the revised spec verdicts survive normalisation, and junk still falls back', () => {
  // MAYBE and NOT_A_LEAD are new. Before this, both collapsed to UNCLEAR, which is why
  // "ordinary post, no premises event" was indistinguishable from "evidence conflicts".
  for (const verdict of ['GOOD', 'BAD', 'UNCLEAR', 'MAYBE', 'NOT_A_LEAD']) {
    assert.equal(normalizeAiResponse({ verdict, reasoning: 'r' }).verdict, verdict);
  }
  assert.equal(normalizeAiResponse({ verdict: 'not_a_lead', reasoning: 'r' }).verdict, 'NOT_A_LEAD');
  assert.equal(normalizeAiResponse({ verdict: 'PROBABLY', reasoning: 'r' }).verdict, 'UNCLEAR');
});
