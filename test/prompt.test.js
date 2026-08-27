import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  constrainAnalysisToEvidence,
  extractPostHistoryEvidence
} from '../server.js';
import { normalizeAiResponse } from '../src/validation.js';

test('prompt never seeds the unsupported 142 count when history is absent', () => {
  const lead = { 'Company Name': 'No History Ltd' };
  const prompt = buildPrompt(lead);
  assert.match(prompt, /Verified sample: unavailable; not a lifetime post count/);
  assert.match(prompt, /"total_posts": null/);
  assert.doesNotMatch(prompt, /"total_posts": 142/);
  assert.match(prompt, /Never invent, extrapolate, or assume post counts/);
  assert.match(prompt, /Do not calculate freshness or infer a post age/);

  const normalized = normalizeAiResponse({
    verdict: 'BAD',
    post_history_analysis: {
      total_posts: 142,
      page_maturity: 'established',
      posting_pattern: 'Long history',
      assessment: 'Old page'
    }
  });
  const constrained = constrainAnalysisToEvidence(normalized, lead);
  assert.equal(constrained.post_history_analysis.total_posts, null);
  assert.equal(constrained.post_history_analysis.page_maturity, 'unknown');
  assert.equal(constrained.post_history_analysis.posting_pattern, 'Insufficient information');
});

test('prompt reads actor activity.recentPosts and caps displayed evidence', () => {
  const recentPosts = Array.from({ length: 12 }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    text: `Actor post ${index + 1}`
  }));
  const lead = {
    'Company Name': 'Activity Ltd',
    fetchResults: {
      rawData: {
        activity: {
          latestPostText: 'Latest actor caption',
          recentPosts
        }
      }
    }
  };
  assert.deepEqual(extractPostHistoryEvidence(lead), {
    totalPosts: 12,
    evidenceStatus: 'sample_available',
    displayedPosts: recentPosts.slice(0, 10)
  });

  const prompt = buildPrompt(lead);
  assert.match(prompt, /Verified sample: 12; not a lifetime post count/);
  assert.match(prompt, /Actor post 10/);
  assert.doesNotMatch(prompt, /Actor post 11/);
  assert.match(prompt, /Post Caption\/Text: Latest actor caption/);
  assert.match(prompt, /"total_posts": 12/);
});

test('rejected publisher history is unknown, not zero posts or evidence of a new business', () => {
  const lead = { fetchResults: { rawData: { activity: {
    recentPosts: [], postsChecked: 10,
    rejectedActivityEvidence: [{ postText: 'Publisher post', reason: 'post-author-mismatch' }]
  } } } };
  const result = constrainAnalysisToEvidence(normalizeAiResponse({
    verdict: 'GOOD',
    reasoning: 'The salon is relocating. The absence of previous posts suggests this is a new page, enhancing the opportunity.',
    key_factors: ['Relocation confirmed', 'No previous post history indicating an established business'],
    red_flags: ['0 total posts indicating no established history'],
    post_history_analysis: { total_posts: 0, page_maturity: 'new' }
  }), lead);
  assert.equal(result.post_history_analysis.total_posts, null);
  assert.equal(result.post_history_analysis.evidence_status, 'unavailable');
  assert.equal(result.post_history_analysis.page_maturity, 'unknown');
  assert.match(result.reasoning, /salon is relocating/);
  assert.doesNotMatch(result.reasoning, /new page|absence of previous posts/i);
  assert.deepEqual(result.key_factors, ['Relocation confirmed']);
  assert.deepEqual(result.red_flags, []);
});

test('COT prompt cannot borrow an unmatched page caption when exact proof is absent', () => {
  const prompt = buildPrompt({ fetchResults: { rawData: {
    contractVersion: 'cot-data-batch-v1', postText: null,
    activity: { latestPostText: 'UNRELATED CAPTION', recentPosts: [] }
  } } });
  assert.doesNotMatch(prompt, /UNRELATED CAPTION/);
  assert.match(prompt, /Post Caption\/Text: Not provided/);
});
