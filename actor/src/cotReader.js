import { parseCotProofDocument } from './cotDocument.js';
import { cotPostKey,cotUrlIdentity } from './cotUrls.js';
import { openFacebookPageSession, openFacebookProofDocument } from './facebookHttpClient.js';
import { fetchTimelinePosts } from './facebookTimelineFeed.js';

// Keep page reads bounded: known parent first, then one exact proof document,
// then its explicitly resolved parent (if different). Never search by caption.
export async function readCotProof(url, options = {}, readers = {}) {
    const openPage = readers.openPage || openFacebookPageSession;
    const openDocument = readers.openDocument || openFacebookProofDocument;
    const timeline = readers.timeline || fetchTimelinePosts;
    const target = cotUrlIdentity(url);
    const result = { session: null, posts: [], resolution: null, preview: null, failureReason: null, scanAttempted: false };
    if (!target) return { ...result, failureReason: 'target-post-identity-unresolved' };
    const visited = new Set();
    async function readParent(parentUrl) {
        if (!parentUrl || visited.has(parentUrl) || options.includePreviousPosts === false) return;
        visited.add(parentUrl);
        const session = await openPage(parentUrl, options);
        if (session.failureReason) { result.failureReason = session.failureReason; return; }
        result.session = session;
        result.scanAttempted = true;
        const feed = await timeline(session, { limit: options.maxPosts || 10, log: options.log });
        result.posts.push(...feed.posts);
        result.failureReason = feed.failureReason;
    }
    await readParent(target.parentUrl);
    if (result.posts.some(post => cotPostKey(post.postUrl) === target.key)) return result;
    const document = await openDocument(target.readUrl, options);
    if (!document.failureReason) {
        const parsed = parseCotProofDocument(document.html, target.readUrl, document.finalUrl);
        result.resolution = parsed.resolution;
        result.preview = parsed.preview;
        result.posts.push(...parsed.posts);
        // Metadata resolves the publisher, never the lead company's identity.
        const resolvedKeys = new Set([target.key, ...(parsed.resolution?.verified ? parsed.resolution.aliasKeys : [])]);
        if (!result.posts.some(post => resolvedKeys.has(cotPostKey(post.postUrl)))) await readParent(parsed.parentUrl);
    } else result.failureReason = document.failureReason;
    const keys = new Set([target.key, ...(result.resolution?.verified ? result.resolution.aliasKeys : [])]);
    if (!result.posts.some(post => keys.has(cotPostKey(post.postUrl)))) {
        let reason = 'target-not-in-public-sample';
        if (target.kind === 'reel') reason = 'reel-proof-unavailable-logged-out';
        if (target.groupId) reason = 'group-proof-unavailable-logged-out';
        result.failureReason ||= reason;
    }
    return result;
}
