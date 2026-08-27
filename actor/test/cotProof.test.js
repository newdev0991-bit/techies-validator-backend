import test from 'node:test';
import assert from 'node:assert/strict';
import { cotPostKey, toCotProofOutput } from '../src/cotProof.js';

const inputUrl = 'https://www.facebook.com/example/posts/123';
const item = { inputUrl, requestKey: 'row:1', status: 'success', scrape: { success: true } };
const post = { postUrl: inputUrl, posted_at_iso: '2026-08-27T10:00:00.000Z', time_source: 'graphql-timeline', storyScoped: true, postText: 'Target text' };
const convert = (posts, output = item) => toCotProofOutput(output, { previousPosts: posts });

test('COT exact post carries trustworthy server time and stable batch identity', () => {
  const result = convert([post]);
  assert.equal(result.timestampProvenance.trusted, true);
  assert.equal(result.contractVersion, 'cot-data-batch-v1');
  assert.equal(result.requestKey, 'row:1');
  assert.equal(result.posted_at_iso, post.posted_at_iso);
});

test('another post, page feed, or unresolved share link never supplies proof freshness', () => {
  for (const url of ['https://facebook.com/example/posts/999', 'https://facebook.com/example', 'https://facebook.com/share/p/abc']) {
    const result = convert([post], { ...item, inputUrl: url });
    assert.equal(result.timestampProvenance.trusted, false);
    assert.equal(result.posted_at_iso, null);
    assert.equal(result.postText, null);
  }
});

test('conflicting exact timestamps on the same day fail closed', () => {
  const result = convert([post, { ...post, posted_at_iso: '2026-08-27T11:00:00Z' }]);
  assert.equal(result.timestampProvenance.conflict, true);
  assert.equal(result.posted_at_iso, null);
});

test('estimated, malformed, unscoped, and failed scrapes cannot produce trusted proof', () => {
  for (const bad of [{ ...post, time_source: 'ocr' }, { ...post, storyScoped: false }, { ...post, posted_at_iso: '2026-08-27' }]) {
    assert.equal(convert([bad]).timestampProvenance.trusted, false);
  }
  assert.equal(convert([post], { ...item, scrape: { success: false } }).timestampProvenance.trusted, false);
});

test('official permalink aliases match but unsafe hosts and mixed group feeds do not', () => {
  assert.equal(cotPostKey(inputUrl), cotPostKey('https://m.facebook.com/permalink.php?story_fbid=123&id=7'));
  assert.equal(cotPostKey(inputUrl), cotPostKey('https://facebook.com/groups/7/permalink/123/'));
  for (const url of ['https://evilfacebook.com/a/posts/123', 'https://user:pass@facebook.com/a/posts/123', 'https://facebook.com/groups/7/posts/123?multi_permalinks=123,456']) {
    assert.equal(cotPostKey(url), '');
  }
});
