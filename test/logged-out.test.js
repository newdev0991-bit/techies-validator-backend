import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCotActorInput } from '../src/cot-batch.js';
import { evaluateLeadFreshness } from '../src/freshness.js';
import { toCotProofOutput } from '../actor/src/cotProof.js';
import { cotPostKey } from '../actor/src/cotUrls.js';

test('single and batch provider paths never read or forward account cookies', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /FACEBOOK_COOKIES|parseFacebookCookies|cookies\s*:/);
  const input = buildCotActorInput([{ requestKey: 'r1', url: 'https://facebook.com/a/posts/1', lead: {} }], { cookies: 'do-not-forward' });
  assert.equal(Object.hasOwn(input, 'cookies'), false);
  assert.equal(input.activityWindowDays, 1);
});

test('verified alternate post identity reaches freshness, while preview-only group remains review', () => {
  const inputUrl = 'https://facebook.com/permalink.php?story_fbid=pfbidRequested&id=100008004346047';
  const alias = 'https://facebook.com/permalink.php?story_fbid=pfbidResolved&id=100008004346047';
  const rawData = toCotProofOutput({ inputUrl, status: 'success', scrape: { success: true } }, {
    proofResolution: { requestedKey: cotPostKey(inputUrl), verified: true, conflict: false, aliasKeys: [cotPostKey(alias)] },
    previousPosts: [{ postUrl: alias, storyScoped: true, time_source: 'graphql-timeline', posted_at_iso: '2026-08-27T07:31:25Z' }]
  });
  assert.equal(evaluateLeadFreshness({ 'Lead Proof URL': inputUrl, fetchResults: { rawData } }, {
    now: new Date('2026-08-27T15:06:00Z')
  }).decision, 'fresh');
  const groupUrl = 'https://facebook.com/groups/234026057722613/?multi_permalinks=1766436707814866';
  const groupData = toCotProofOutput({ inputUrl: groupUrl, status: 'error', scrape: { success: false } }, {
    previousPosts: [], proofPreview: { text: 'New management', complete: false }, proofFailureReason: 'group-proof-unavailable-logged-out'
  });
  assert.equal(evaluateLeadFreshness({ 'Lead Proof URL': groupUrl, fetchResults: { rawData: groupData } }).decision, 'manual_review');
  const datedGroup = toCotProofOutput({ inputUrl: groupUrl, status: 'success', scrape: { success: true } }, {
    previousPosts: [{ postUrl: 'https://facebook.com/groups/234026057722613/posts/1766436707814866/',
      storyScoped: true, time_source: 'facebook-story-json', posted_at_iso: '2026-08-26T23:49:24Z' }]
  });
  assert.equal(evaluateLeadFreshness({ 'Lead Proof URL': groupUrl, fetchResults: { rawData: datedGroup } }, {
    now: new Date('2026-08-27T15:06:00Z')
  }).decision, 'fresh');
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
