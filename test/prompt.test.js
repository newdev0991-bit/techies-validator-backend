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

test('prompt treats a personal profile as assessable, not an automatic exclusion', () => {
  const prompt = buildPrompt({ 'Company Name': 'Rad & Razor' });
  assert.match(prompt, /A PERSONAL PROFILE IS NOT AUTOMATICALLY BAD OR UNCLEAR/);
  assert.match(prompt, /assess the premises event exactly\s+as you would for a business Page/);
  // The old BAD list lumped "non-commercial personal pages" in with churches/charities.
  assert.doesNotMatch(prompt, /non-commercial personal pages/);
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

test('nonempty capped samples cannot prove a new page or lifetime volume', () => {
  for (const size of [9, 10]) {
    const lead = { fetchResults: { rawData: { activity: { recentPosts: Array.from({ length: size }, () => ({ text: 'An observed post' })) } } } };
    const prompt = buildPrompt(lead);
    assert.doesNotMatch(prompt, /< 20|> 50|50% weight|sparse post history/);
    const constrained = constrainAnalysisToEvidence(normalizeAiResponse({ verdict: 'GOOD',
      reasoning: 'The business is relocating. Sparse posting history indicates a new page.',
      key_factors: ['New page with 9 posts', 'Explicit relocation'],
      post_history_analysis: { page_maturity: 'new', total_posts: 9 }
    }), lead);
    assert.equal(constrained.post_history_analysis.total_posts, size);
    assert.equal(constrained.post_history_analysis.page_maturity, 'unknown');
    assert.doesNotMatch(constrained.reasoning, /indicates a new page/);
    assert.deepEqual(constrained.key_factors, ['Explicit relocation']);
  }
});

// Balanced-validation pass (2026-09-13): the dashboard showed most rejections
// falling into "internal expansion" and "routine reopening" being conflated with
// their genuine-COT-event counterparts (a second site; a change of operator/site).
// Lock the prompt's explicit second-site-vs-same-site and new-operator-vs-routine
// distinctions in place so a future edit cannot silently narrow them back.
test('prompt distinguishes a genuine second site from growing the existing one', () => {
  const prompt = buildPrompt({ 'Company Name': 'Example Salon' });
  assert.match(prompt, /SECOND SITE IS GOOD, GROWING THE EXISTING ONE IS NOT/);
  assert.match(prompt, /second\/additional standalone location/);
  assert.match(prompt, /is there now a second address/i);
  assert.match(prompt, /second salon in Didsbury/);
  assert.match(prompt, /knocked through into the unit next door/);
});

test('prompt distinguishes reopening under a new operator from a routine reopening', () => {
  const prompt = buildPrompt({ 'Company Name': 'Example Pub' });
  assert.match(prompt, /A REAL CHANGE OF OPERATOR OR SITE IS GOOD, COMING BACK AS-IS IS NOT/);
  assert.match(prompt, /did the operator or the site change/i);
  assert.match(prompt, /reopen the old Ivy House pub under new ownership/);
  assert.match(prompt, /back open again after our summer break/);
});

// Casefile case 07 (2026-09-13): premises still being searched for/not yet signed
// should be delivered early as a qualifying GOOD signal, not held back or treated
// as a minor update. Lock this in so a future edit cannot silently revert it.
test('prompt treats actively searching for premises as a qualifying GOOD signal', () => {
  const prompt = buildPrompt({ 'Company Name': 'Example Bistro' });
  assert.match(prompt, /PREMISES IN PROGRESS -> GOOD/);
  assert.match(prompt, /deliver early, before the lease is even signed/i);
  assert.match(prompt, /are they actively trying to secure a site/i);
  assert.match(prompt, /looking for new premises/i);
});
