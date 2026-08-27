import { cotPostKey } from './cotUrls.js';

export { cotPageReadUrl, cotPostKey } from './cotUrls.js';

// Keep the reference transport unchanged. COT accepts only the submitted post's
// server timestamp, never the page's latest activity or a rendered date estimate.
export function toCotProofOutput(output, result) {
    const requestedUrl = output.inputUrl;
    const targetKey = cotPostKey(requestedUrl);
    const resolution = result.proofResolution;
    const verifiedResolution = resolution?.requestedKey === targetKey && resolution?.verified === true && !resolution?.conflict;
    const keys = new Set([targetKey, ...(verifiedResolution ? resolution.aliasKeys : [])].filter(Boolean));
    const candidates = (result.previousPosts || []).filter(post =>
        targetKey && keys.has(cotPostKey(post.postUrl)));
    const exact = candidates.filter(post => post.storyScoped === true &&
        ['graphql-timeline', 'facebook-story-json'].includes(post.time_source) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(post.posted_at_iso || '') &&
        Number.isFinite(Date.parse(post.posted_at_iso)));
    const dates = new Set(exact.map(post => new Date(post.posted_at_iso).toISOString()));
    const conflict = dates.size > 1 || resolution?.conflict === true;
    const matched = output.scrape?.success === true && candidates.length > 0 &&
        exact.length === candidates.length && dates.size === 1 && !conflict;
    const post = matched ? exact[0] : null;
    const timestamp = post ? new Date(post.posted_at_iso).toISOString() : null;
    let reason = result.proofFailureReason || 'target-not-in-public-sample';
    if (candidates.length) reason = 'target-date-untrusted';
    if (!targetKey) reason = 'target-post-identity-unresolved';
    if (conflict) reason = 'target-date-conflict';
    if (matched) reason = 'exact-target-server-timestamp';
    let retrievalStatus = result.proofPreview ? 'preview-only' : 'unverified';
    if (matched) retrievalStatus = 'verified';
    return {
        ...output,
        contractVersion: 'cot-data-batch-v1',
        engineVersion: 'cot-http-v2',
        proofRetrieval: { status: retrievalStatus, reason },
        proofPreview: result.proofPreview || null,
        postUrl: requestedUrl,
        requestedPostUrl: requestedUrl,
        postText: post?.postText || null,
        postDate: timestamp,
        posted_at_iso: timestamp,
        posted_at_raw: timestamp,
        time_source: matched ? post.time_source : 'none',
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
            identityResolution: verifiedResolution ? resolution : null,
            reason,
            conflict,
        },
    };
}
