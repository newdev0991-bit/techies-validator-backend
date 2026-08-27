import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCotProofDocument } from '../src/cotDocument.js';
import { toCotProofOutput } from '../src/cotProof.js';
import { readCotProof } from '../src/cotReader.js';
import { cotPostKey, cotUrlIdentity } from '../src/cotUrls.js';

// Sanitized metadata shapes observed in the public documents on 2026-08-27.
const salon = 'https://www.facebook.com/permalink.php?story_fbid=pfbidOriginal&id=100008004346047';
const alias = 'https://www.facebook.com/permalink.php?story_fbid=pfbidResolved&id=100008004346047';
const canonical = 'https://www.facebook.com/100008004346047/posts/relocation-announcement/4517937788482988/';
const group = 'https://www.facebook.com/groups/234026057722613/posts/1766436707814866/';
const reel = 'https://www.facebook.com/reel/27965803009740820';
const video = 'https://www.facebook.com/Centrestagepropertystaging/videos/behind-the-scenes/27965803009740820/';
const html = (canonicalUrl, route = null) => `<meta property="og:description" content="Public preview...">
<meta property="og:url" content="${canonicalUrl}"><link rel="canonical" href="${canonicalUrl}">
<script type="application/json">${JSON.stringify({ route })}</script>`;
const route = { url: new URL(salon).pathname + new URL(salon).search,
    params: { story_fbid: 'pfbidResolved', id: '100008004346047' }, routePath: '/permalink.php/' };
const story = (postUrl, date = '2026-08-27T07:31:25.000Z') => ({
    postUrl, posted_at_iso: date, time_source: 'graphql-timeline', storyScoped: true,
    postText: 'Relocation caption', author: 'Publisher, not lead business name',
});
const output = (url, proof) => toCotProofOutput({ inputUrl: url, status: 'success', scrape: { success: true } }, {
    previousPosts: proof.posts, proofResolution: proof.resolution,
    proofPreview: proof.preview, proofFailureReason: proof.failureReason,
});

test('single group permalink normalizes and strips tracking; ambiguous or conflicting feeds fail closed', () => {
    assert.equal(cotUrlIdentity('https://www.facebook.com/groups/234026057722613/?multi_permalinks=1766436707814866&tracking=x').readUrl, group);
    assert.equal(cotPostKey(group), cotPostKey(group.replace('/posts/', '/permalink/')));
    for (const url of [`${group  }?multi_permalinks=1,2`, `${group  }?multi_permalinks=999`, `${group  }?multi_permalinks=1&multi_permalinks=2`,
        'https://facebook.com/groups/7', 'https://user:pass@facebook.com/a/posts/123', 'https://facebook.com.evil.test/a/posts/123', 'file:///a/posts/123']) {
        assert.equal(cotPostKey(url), '');
    }
});

test('slugged post/video URLs use the object ID, not the human-readable slug', () => {
    assert.equal(cotPostKey(canonical), 'url|facebook-post:4517937788482988');
    assert.equal(cotPostKey(video), 'url|facebook-video:27965803009740820');
    assert.notEqual(cotPostKey(video), cotPostKey(reel));
});

test('Salon route maps alternate pfbid only when bound to the requested URL and owner', () => {
    const doc = parseCotProofDocument(html(canonical, route), salon);
    assert.equal(doc.resolution.verified, true);
    assert.ok(doc.resolution.aliasKeys.includes(cotPostKey(alias)));
    const result = output(salon, { ...doc, posts: [story(alias)] });
    assert.equal(result.time_target_matched, true);
    assert.equal(result.postDate, '2026-08-27T07:31:25.000Z');
    assert.equal(result.postText, 'Relocation caption');
    assert.equal(result.postUrl, salon);
    assert.equal(output(salon, { ...doc, posts: [story(alias, '2026-08-27T07:31:25Z'), story(alias, '2026-08-27T08:31:25Z')] }).postDate, null);
    for (const bad of [{ ...route, url: '/someone/posts/999' }, { ...route, params: { ...route.params, id: '999' } }]) {
        const invalid = parseCotProofDocument(html(canonical, bad), salon);
        assert.equal(output(salon, { ...invalid, posts: [story(alias)] }).postDate, null);
    }
});

test('caption similarity, unrelated redirects, and conflicting canonical metadata never prove identity', () => {
    assert.equal(output(salon, { posts: [story(alias)] }).postDate, null);
    assert.equal(parseCotProofDocument(html(canonical, route), salon, 'https://facebook.com/login').resolution, null);
    const conflict = parseCotProofDocument(`${html(canonical, route)  }<link rel="canonical" href="https://facebook.com/other/posts/999">`, salon);
    assert.equal(conflict.resolution.conflict, true);
    assert.equal(output(salon, { ...conflict, posts: [story(alias)] }).postDate, null);
});

test('reel document explicitly bridges to its canonical video and parent, not arbitrary same-number objects', () => {
    const doc = parseCotProofDocument(html(video), reel);
    assert.equal(doc.parentUrl, 'https://www.facebook.com/Centrestagepropertystaging');
    assert.equal(output(reel, { ...doc, posts: [story(video)] }).time_target_matched, true);
    assert.equal(output(reel, { posts: [story(video)] }).time_target_matched, false);
    assert.equal(parseCotProofDocument(html(video.replace('27965803009740820', '999')), reel).parentUrl, null);
});

test('group preview is retained separately but metadata cannot manufacture a timestamp', () => {
    const doc = parseCotProofDocument(`${html(group)  }<script>window.creation_time=1787815885</script>`, group);
    const result = output(group, { ...doc, posts: [], failureReason: 'group-proof-unavailable-logged-out' });
    assert.equal(result.postText, null);
    assert.equal(result.postDate, null);
    assert.equal(result.proofPreview.complete, false);
    assert.equal(result.proofRetrieval.status, 'preview-only');
});

test('direct group story JSON accepts only the exact dated story, never a neighbouring timestamp', () => {
    const payload = { node: { comet_sections: { unrelated: { creation_time: 1700000000 },
        content: { story: { creation_time: 1787815885, url: group } } } } };
    const doc = parseCotProofDocument(`${html(group)  }<script type="application/json">${JSON.stringify(payload)}</script>`, group);
    assert.equal(output(group, doc).postDate, new Date(1787815885 * 1000).toISOString());
    const other = parseCotProofDocument(`${html(group)  }<script type="application/json">${JSON.stringify(payload).replace('1766436707814866', '999')}</script>`, group);
    assert.equal(output(group, other).postDate, null);
});

test('reader retains the standard exact-post fast path and makes no extra document request', async () => {
    let documentCalls = 0;
    const url = 'https://www.facebook.com/advasign/posts/pfbidExact';
    const proof = await readCotProof(url, {}, {
        openPage: async () => ({ pageId: '1', html: '' }),
        timeline: async () => ({ posts: [story(url)], failureReason: null }),
        openDocument: async () => { documentCalls++; throw new Error('not needed'); },
    });
    assert.equal(output(url, proof).time_target_matched, true);
    assert.equal(documentCalls, 0);
});

test('reel resolves its public parent without treating the reel as a page timeline', async () => {
    const calls = [];
    const proof = await readCotProof(reel, {}, {
        openDocument: async url => { calls.push(['document', url]); return { html: html(video), finalUrl: url }; },
        openPage: async url => { calls.push(['page', url]); return { pageId: '1', html: '' }; },
        timeline: async () => ({ posts: [story(video)], failureReason: null }),
    });
    assert.deepEqual(calls, [['document', reel], ['page', 'https://www.facebook.com/Centrestagepropertystaging']]);
    assert.equal(output(reel, proof).time_target_matched, true);
});

test('unavailable group remains bounded and reviewable without calling page timeline or borrowing posts', async () => {
    const proof = await readCotProof(group, {}, {
        openDocument: async () => ({ html: html(group), finalUrl: group }),
        openPage: async () => { throw new Error('group is not a page'); },
        timeline: async () => { throw new Error('must not guess a publisher'); },
    });
    assert.equal(proof.failureReason, 'group-proof-unavailable-logged-out');
    assert.equal(output(group, proof).time_target_matched, false);
});
