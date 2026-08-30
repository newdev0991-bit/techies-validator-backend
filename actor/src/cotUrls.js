const OBJECT_ID = /^(?:\d+|pfbid[A-Za-z0-9]+)$/;

export function facebookUrl(value, base) {
    try {
        const url = new URL(value, base);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
            !(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) return null;
        return url;
    } catch { return null; }
}

// A single group permalink is a post, not a feed. Multiple or conflicting IDs
// remain unresolved; tracking parameters never participate in post identity.
export function cotUrlIdentity(value) {
    const url = facebookUrl(value);
    if (!url) return null;
    const group = url.pathname.match(/^\/groups\/([^/]+)(?:\/(?:posts|permalink)\/(?:[^/]+\/)?([^/]+))?\/?$/i);
    let id;
    let kind = 'post';
    let parentUrl = null;
    const multi = url.searchParams.getAll('multi_permalinks');
    if (multi.length) {
        if (!group || multi.length !== 1 || !/^\d+$/.test(multi[0]) ||
            (group[2] && group[2] !== multi[0])) return null;
        id = multi[0];
    } else if (group?.[2]) {
        id = group[2];
    } else if (/^\/permalink.php\/?$/i.test(url.pathname)) {
        if (url.searchParams.getAll('story_fbid').length !== 1 || url.searchParams.getAll('id').length !== 1) return null;
        id = url.searchParams.get('story_fbid');
        const owner = url.searchParams.get('id');
        if (/^\d+$/.test(owner || '')) parentUrl = `https://www.facebook.com/profile.php?id=${owner}`;
    } else {
        // Facebook's canonical URLs can include a human-readable slug before ID.
        const post = url.pathname.match(/^\/([^/]+)\/(posts|videos)\/(?:[^/]+\/)?([^/]+)\/?$/i);
        const reel = url.pathname.match(/^\/reel\/([^/]+)\/?$/i);
        if (post && !['groups', 'share'].includes(post[1].toLowerCase())) {
            id = post[3];
            kind = post[2].toLowerCase() === 'videos' ? 'video' : 'post';
            parentUrl = `https://www.facebook.com/${post[1]}`;
        } else if (reel) {
            id = reel[1];
            kind = 'reel';
        } else if (/^\/watch\/?$/i.test(url.pathname) && url.searchParams.getAll('v').length === 1) {
            id = url.searchParams.get('v');
            kind = 'video';
        }
    }
    if (!OBJECT_ID.test(id || '')) return null;
    let readUrl = url.href;
    if (group) readUrl = `https://www.facebook.com/groups/${group[1]}/posts/${id}/`;
    else if (kind === 'reel') readUrl = `https://www.facebook.com/reel/${id}`;
    else if (/^\/watch\/?$/i.test(url.pathname)) readUrl = `https://www.facebook.com/watch/?v=${id}`;
    else {
        for (const name of [...url.searchParams.keys()]) if (!['story_fbid', 'id'].includes(name)) url.searchParams.delete(name);
        url.hash = '';
        readUrl = url.href;
    }
    return { key: `url|facebook-${kind}:${id}`, id, kind, readUrl, parentUrl, groupId: group?.[1] || null };
}

export function cotPostKey(value) { return cotUrlIdentity(value)?.key || ''; }
export function cotPageReadUrl(value) { return cotUrlIdentity(value)?.parentUrl || cotUrlIdentity(value)?.readUrl || value; }
