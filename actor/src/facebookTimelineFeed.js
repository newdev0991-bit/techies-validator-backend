/**
 * Logged-out Facebook page timeline reader.
 *
 * The browser activity scan inferred a post date from rendered text ("22 hours ago"), then paired
 * it with an author by walking the DOM. On current Facebook markup that pairing fails - measured at
 * zero attributed stories across every page tested - so the scan fell back to hover probing and
 * OCR, and still returned nothing.
 *
 * Facebook's own Comet timeline query answers the same question exactly: each post's
 * `creation_time` as a server epoch, its permalink, and its author. It needs no account, so there
 * is no cookie to expire and no session to checkpoint.
 *
 * Ported from the Python facebook-profile-scraper actor, trimmed to what the activity check needs:
 * date, permalink, author, text. Media, reactions and comment counts are deliberately not parsed.
 */
import { postGraphql } from './facebookHttpClient.js';

const TIMELINE_DOC_ID = '10072156592850871';
const TIMELINE_FRIENDLY_NAME = 'ProfileCometTimelineFeedRefetchQuery';

/**
 * Pinned Relay client tokens.
 *
 * ponytail: these identify a specific Facebook client build and are copied verbatim from the
 * working Python actor. They are stale by design - Facebook accepts them today and will stop one
 * day without notice. When the timeline stops returning units, refresh this block and `doc_id`
 * from a live logged-out page load rather than trying to derive them.
 */
const PINNED_CLIENT_FIELDS = {
    av: '0',
    __aaid: '0',
    __user: '0',
    __a: '1',
    __req: 'f',
    __hs: '20164.HYP:comet_loggedout_pkg.2.1...0',
    dpr: '1',
    __ccg: 'MODERATE',
    __rev: '1020954395',
    __s: 'olmz9l:tn4p58:72gxsw',
    __hsi: '7482762573766931521',
    __dyn: '7xeUmwlEnwn8yEqxemh0no6u5U4e1Nxt3odEc8co5S3O2Saw8i2S1DwUx60gu0luq1ew6ywIK1Rw8G11wBz83WwgEcEhwGwQw9m1YwBgao6C0Mo2swlo5qfK0zEkxe2Gewyw9G2SU4i5oe85nxmu3W0Gpo8o11E5C2-azo3iwPwbS16xi4UdUcobUak0KU566E6C13G486S1ixu4FqwIxW1fy8bUaU3ywo8',
    __csr: '',
    __hsdp: '',
    __hblp: '',
    __comet_req: '15',
    jazoest: '2971',
    __spin_r: '1020954395',
    __spin_b: 'trunk',
    __spin_t: '1742216426',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: TIMELINE_FRIENDLY_NAME,
    server_timestamps: 'true',
    doc_id: TIMELINE_DOC_ID,
};

/**
 * Relay provider flags. The timeline and its cursor refetch share one persisted query, so the
 * complete set must be sent on every call - omitting any of them fails the whole query.
 */
const RELAY_PROVIDERS = {
    __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: false,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: false,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
    __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: false,
    __relay_internal__pv__CometFeedStoryDynamicResolutionPhotoAttachmentRenderer_experimentWidthrelayprovider: 500,
    __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
    __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
    __relay_internal__pv__IsMergQAPollsrelayprovider: false,
    __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: false,
    __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
    __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
    __relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider: false,
    __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider: false,
    __relay_internal__pv__EventCometCardImage_prefetchEventImagerelayprovider: false,
    __relay_internal__pv__VideoPlayerRelayReplaceDashManifestWithPlaylistrelayprovider: true,
    __relay_internal__pv__StoriesTrayShouldShowMetadatarelayprovider: false,
    __relay_internal__pv__StoriesRingrelayprovider: false,
};

const TIMELINE_UNITS_MARKER = '"timeline_list_feed_units":';
const MAX_CURSOR_PAGES = 5;

export const TIMELINE_TIME_SOURCE = 'graphql-timeline';

/** Depth-first search for the first value stored under `key`. */
function findFirstValue(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (!Array.isArray(node) && node[key] !== undefined) return node[key];
    for (const value of Array.isArray(node) ? node : Object.values(node)) {
        const found = findFirstValue(value, key);
        if (found !== undefined) return found;
    }
    return undefined;
}

/**
 * The permalink lives on the story object that also carries the timestamp. Other story objects in
 * the same edge point at attachments and comment threads, so matching on `url` alone picks the
 * wrong link.
 */
function findDatedStory(node) {
    if (!node || typeof node !== 'object') return null;
    if (!Array.isArray(node) && node.creation_time && typeof node.url === 'string') return node;
    for (const value of Array.isArray(node) ? node : Object.values(node)) {
        const found = findDatedStory(value);
        if (found) return found;
    }
    return null;
}

function epochToIso(epochSeconds) {
    const seconds = Number(epochSeconds);
    if (!Number.isFinite(seconds) || seconds < 946684800 || seconds > 4102444800) return null;
    return new Date(seconds * 1000).toISOString();
}

/**
 * One timeline edge in the shape the activity evidence policy already consumes, so these posts are
 * judged by the same author/permalink/date rules as any other activity evidence.
 */
export function parseTimelineEdge(edge) {
    const sections = edge?.node?.comet_sections;
    if (!sections) return null;

    const datedStory = findDatedStory(sections);
    const iso = epochToIso(datedStory?.creation_time);
    const postUrl = datedStory?.url;
    if (!iso || !postUrl) return null;

    const actor = findFirstValue(findFirstValue(sections, 'actor_photo'), 'actors')?.[0] || {};
    const text = findFirstValue(findFirstValue(sections, 'message'), 'text');

    return {
        postUrl,
        posted_at_raw: iso,
        posted_at_iso: iso,
        time_source: TIMELINE_TIME_SOURCE,
        postDate: iso,
        postText: typeof text === 'string' ? text : '',
        author: String(actor.name || '').trim() || null,
        storyScoped: true,
        status: 'success',
    };
}

function buildVariables({ pageId, count, cursor, afterTime, beforeTime }) {
    return {
        afterTime,
        beforeTime,
        count,
        cursor: cursor || null,
        feedLocation: 'TIMELINE',
        feedbackSource: 0,
        focusCommentID: null,
        memorializedSplitTimeFilter: null,
        omitPinnedPost: true,
        postedBy: { group: 'OWNER' },
        privacy: null,
        privacySelectorRenderLocation: 'COMET_STREAM',
        renderLocation: 'timeline',
        scale: 1.5,
        // Facebook caps a timeline response by `stream_count`, not `count`: leaving this at 1 costs
        // one full round trip per post returned.
        stream_count: count,
        taggedInOnly: null,
        trackingCode: null,
        useDefaultActor: false,
        id: pageId,
        ...RELAY_PROVIDERS,
    };
}

/** Facebook guards JSON responses with a `for (;;);` prefix that is not valid JSON. */
function stripJsonGuard(body) {
    return String(body || '').replace(/^\s*for\s*\(;;\);/, '');
}

function readTimelineEdges(body) {
    const edges = [];
    for (const line of stripJsonGuard(body).split('\n')) {
        if (!line.includes(TIMELINE_UNITS_MARKER)) continue;
        try {
            const units = findFirstValue(JSON.parse(line), 'timeline_list_feed_units');
            if (Array.isArray(units?.edges)) edges.push(...units.edges);
        } catch {
            // A truncated chunk is normal in a streamed Relay response; later lines still parse.
        }
    }
    return edges;
}

/**
 * Read a page's recent posts on an established logged-out session.
 *
 * A failure is reported as an empty post list plus a reason - never as a throw - so one page whose
 * timeline cannot be read stays a row-level outcome rather than ending the batch.
 */
export async function fetchTimelinePosts(
    session,
    { limit = 3, afterTime = null, beforeTime = null, log = () => {} } = {},
) {
    if (!session?.pageId) {
        return { posts: [], failureReason: 'timeline-requires-a-resolved-page-id' };
    }
    const requestedLimit = Math.max(1, Math.min(50, Number(limit) || 1));

    const posts = [];
    const seenUrls = new Set();
    let cursor = null;

    for (let round = 0; round < MAX_CURSOR_PAGES; round++) {
        const variables = buildVariables({
            pageId: session.pageId,
            count: requestedLimit,
            cursor,
            afterTime,
            beforeTime,
        });
        const { body, failureReason } = await postGraphql(
            session,
            { ...PINNED_CLIENT_FIELDS, variables: JSON.stringify(variables) },
            { friendlyName: TIMELINE_FRIENDLY_NAME, log },
        );
        if (failureReason) return { posts, failureReason };

        const edges = readTimelineEdges(body);
        if (!edges.length) {
            return { posts, failureReason: posts.length ? null : 'timeline-returned-no-units' };
        }

        for (const edge of edges) {
            const post = parseTimelineEdge(edge);
            if (!post || seenUrls.has(post.postUrl)) continue;
            seenUrls.add(post.postUrl);
            posts.push(post);
        }
        log(`   timeline feed: ${posts.length}/${requestedLimit} post(s) after ${round + 1} call(s)`);

        cursor = edges[edges.length - 1]?.cursor || null;
        if (!cursor || posts.length >= requestedLimit) break;
    }

    return { posts: posts.slice(0, requestedLimit), failureReason: null };
}
