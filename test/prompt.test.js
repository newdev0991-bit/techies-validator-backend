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
  assert.match(prompt, /Previous Posts \(Total: 0\)/);
  assert.match(prompt, /"total_posts": 0/);
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
  assert.equal(constrained.post_history_analysis.total_posts, 0);
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
    displayedPosts: recentPosts.slice(0, 10)
  });

  const prompt = buildPrompt(lead);
  assert.match(prompt, /Previous Posts \(Total: 12\)/);
  assert.match(prompt, /Actor post 10/);
  assert.doesNotMatch(prompt, /Actor post 11/);
  assert.match(prompt, /Post Caption\/Text: Latest actor caption/);
  assert.match(prompt, /"total_posts": 12/);
});
