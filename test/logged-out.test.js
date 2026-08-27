import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCotActorInput } from '../src/cot-batch.js';
import { evaluateLeadFreshness } from '../src/freshness.js';
import { toCotProofOutput } from '../actor/src/cotProof.js';

test('single and batch provider paths never read or forward account cookies', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /FACEBOOK_COOKIES|parseFacebookCookies|cookies\s*:/);
  const input = buildCotActorInput([{ requestKey: 'r1', url: 'https://facebook.com/a/posts/1', lead: {} }], { cookies: 'do-not-forward' });
  assert.equal(Object.hasOwn(input, 'cookies'), false);
  assert.equal(input.activityWindowDays, 1);
});

test('HTTP proof evidence obeys the exact 24-hour boundary and never borrows page activity', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const inputUrl = 'https://www.facebook.com/a/posts/123';
  const output = { inputUrl, status: 'success', scrape: { success: true } };
  const make = (date, url = inputUrl) => toCotProofOutput(output, { previousPosts: [{
    postUrl: url, posted_at_iso: date, storyScoped: true, time_source: 'graphql-timeline'
  }] });
  for (const [date, expected] of [['2026-08-26T12:00:00Z', 'fresh'], ['2026-08-26T11:59:59Z', 'stale']]) {
    const rawData = make(date);
    const freshness = evaluateLeadFreshness({ 'Lead Proof URL': inputUrl, fetchResults: { rawData } }, { now });
    assert.equal(freshness.decision, expected);
    assert.equal(freshness.autoRejectEligible, expected === 'stale');
  }
  const unmatched = make('2026-08-27T11:00:00Z', 'https://www.facebook.com/a/posts/999');
  assert.equal(unmatched.posted_at_iso, null);
  assert.equal(unmatched.timestampProvenance.trusted, false);
});
