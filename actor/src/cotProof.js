import { describeActivityStory } from './activityScanPolicy.js';

// Keep the reference transport unchanged. COT accepts only the submitted post's
// server timestamp, never the page's latest activity or a rendered date estimate.
export function cotPostKey(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.searchParams.has('multi_permalinks')) return '';
        // Group permalink and /posts/ are spellings of the same post object.
        url.pathname = url.pathname.replace(/\/permalink\//i, '/posts/');
        return describeActivityStory({ postUrl: url.href }).strongKey;
    } catch { return ''; }
}

export function toCotProofOutput(output, result) {
    const requestedUrl = output.inputUrl;
    const targetKey = cotPostKey(requestedUrl);
    const candidates = (result.previousPosts || []).filter(post =>
        targetKey && cotPostKey(post.postUrl) === targetKey);
    const exact = candidates.filter(post => post.storyScoped === true &&
        post.time_source === 'graphql-timeline' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(post.posted_at_iso || '') &&
        Number.isFinite(Date.parse(post.posted_at_iso)));
    const dates = new Set(exact.map(post => new Date(post.posted_at_iso).toISOString()));
    const conflict = dates.size > 1;
    const matched = output.scrape?.success === true && candidates.length > 0 &&
        exact.length === candidates.length && dates.size === 1;
    const post = matched ? exact[0] : null;
    const timestamp = post ? new Date(post.posted_at_iso).toISOString() : null;
    const reason = matched ? 'exact-target-server-timestamp' : conflict ? 'target-date-conflict' :
        !targetKey ? 'target-post-identity-unresolved' : candidates.length ? 'target-date-untrusted' : 'target-not-in-public-sample';
    return {
        ...output,
        contractVersion: 'cot-data-batch-v1',
        engineVersion: 'cot-http-v1',
        postUrl: requestedUrl,
        requestedPostUrl: requestedUrl,
        postText: post?.postText || null,
        postDate: timestamp,
        posted_at_iso: timestamp,
        posted_at_raw: timestamp,
        time_source: matched ? 'graphql-timeline' : 'none',
        time_target_matched: matched,
        time_confidence: matched ? 'high' : 'low',
        time_precision: matched ? 'exact' : 'unknown',
        time_estimated: false,
        timestampProvenance: {
            targetPostMatched: matched,
            trusted: matched,
            method: matched ? 'exact-facebook-post-id' : null,
            confidence: matched ? 'high' : 'low',
            precision: matched ? 'exact' : 'unknown',
            estimated: false,
            requestedUrl,
            observedUrl: post?.postUrl || null,
            requestedPostId: targetKey || null,
            observedPostId: post ? cotPostKey(post.postUrl) : null,
            reason,
            conflict,
        },
    };
}
