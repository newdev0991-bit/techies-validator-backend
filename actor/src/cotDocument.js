import { cotPostKey, cotUrlIdentity, facebookUrl } from './cotUrls.js';
import { parseTimelineEdge } from './facebookTimelineFeed.js';
import { decodeBasicEntities } from './htmlText.js';

function attributes(tag) {
    return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
        .map(match => [match[1].toLowerCase(), decodeBasicEntities(match[2] ?? match[3])]));
}

function metadata(html) {
    const values = Object.create(null);
    for (const match of html.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
        const attr = attributes(match[0]);
        const key = attr.property || attr.name || (attr.rel === 'canonical' ? 'canonical' : null);
        if (key) (values[key] ||= []).push(attr.content || attr.href || '');
    }
    return values;
}

// Read inert JSON only. No script execution, fuzzy caption matches, or dates
// lifted from unrelated nested objects. Bound traversal on malformed documents.
function jsonObjects(html) {
    const stack = [];
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (attributes(match[1]).type !== 'application/json') continue;
        try { stack.push(JSON.parse(match[2])); } catch { /* incomplete stream */ }
    }
    const objects = [];
    for (let visited = 0; stack.length && visited < 100000; visited++) {
        const node = stack.pop();
        if (typeof node === 'string' && (node.startsWith('[') || node.startsWith('{')) && node.length < 1000000) {
            try { stack.push(JSON.parse(node)); } catch { /* ordinary string */ }
        } else if (node && typeof node === 'object') {
            if (!Array.isArray(node)) objects.push(node);
            stack.push(...Object.values(node));
        }
    }
    return objects;
}

export function parseCotProofDocument(html, requestedUrl, finalUrl = requestedUrl) {
    const target = cotUrlIdentity(requestedUrl);
    const empty = { resolution: null, preview: null, posts: [], parentUrl: null };
    // An unrelated redirect or login page cannot establish alias identity.
    if (!target || cotPostKey(finalUrl) !== target.key) return empty;
    const source = String(html || '');
    const meta = metadata(source);
    const nodes = jsonObjects(source);
    const routeKeys = new Set();
    for (const node of nodes) {
        if (!node.params || typeof node.routePath !== 'string' || typeof node.url !== 'string') continue;
        const routeUrl = facebookUrl(node.url, requestedUrl);
        if (!routeUrl || cotPostKey(routeUrl.href) !== target.key) continue;
        let alias;
        if (node.routePath === '/permalink.php/' && node.params.id === new URL(target.readUrl).searchParams.get('id')) {
            alias = `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(node.params.story_fbid || '')}&id=${node.params.id}`;
        } else if (node.params.story_id && target.groupId === node.params.idorvanity) {
            alias = `https://www.facebook.com/groups/${target.groupId}/posts/${node.params.story_id}/`;
        }
        const key = cotPostKey(alias);
        if (key) routeKeys.add(key);
    }
    const canonicals = [...(meta.canonical || []), ...(meta['og:url'] || [])]
        .map(cotUrlIdentity).filter(Boolean);
    const canonicalKeys = new Set(canonicals.map(item => item.key));
    const conflict = routeKeys.size > 1 || canonicalKeys.size > 1;
    // A group canonical cannot resolve to a different group/story; a reel can
    // map to a video only when Facebook explicitly publishes the same media ID.
    const canonical = canonicals[0];
    let compatibleCanonical = false;
    if (canonical && target.groupId) compatibleCanonical = canonical.groupId === target.groupId && canonical.id === target.id;
    else if (canonical && ['reel', 'video'].includes(target.kind)) {
        compatibleCanonical = ['reel', 'video'].includes(canonical.kind) && canonical.id === target.id;
    } else if (canonical) {
        compatibleCanonical = canonical.kind === 'post' && !canonical.groupId &&
            (!target.parentUrl || canonical.parentUrl === target.parentUrl ||
             canonical.parentUrl === `https://www.facebook.com/${new URL(target.readUrl).searchParams.get('id')}`);
    }
    const resolution = {
        requestedKey: target.key,
        requestedUrl: target.readUrl,
        verified: !conflict && (routeKeys.size > 0 || Boolean(compatibleCanonical)),
        conflict,
        method: 'facebook-public-document',
        aliasKeys: conflict ? [] : [...new Set([...routeKeys, ...(compatibleCanonical ? [canonical.key] : [])])],
    };
    const keys = new Set([target.key, ...(resolution.verified ? resolution.aliasKeys : [])]);
    const posts = [];
    for (const node of nodes) {
        if (!node.comet_sections) continue;
        const post = parseTimelineEdge({ node });
        if (post && keys.has(cotPostKey(post.postUrl))) posts.push({ ...post, time_source: 'facebook-story-json' });
    }
    const previewText = meta['og:description']?.[0] || '';
    return {
        resolution,
        parentUrl: !conflict && compatibleCanonical ? canonical.parentUrl : null,
        posts: conflict ? [] : posts,
        preview: !conflict && compatibleCanonical && previewText ? {
            text: previewText, source: 'facebook-og-description', complete: false,
            requestedUrl: target.readUrl, canonicalUrl: canonical.readUrl,
        } : null,
    };
}
