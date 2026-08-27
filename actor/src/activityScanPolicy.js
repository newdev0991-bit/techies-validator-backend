const DEFAULT_CANONICALIZE_URL = (value) => String(value || '').trim();

const RESOLVABLE_AMBIGUITY_REASONS = new Set(['invalid-date', 'missing-date', 'missing-timestamp', 'unparseable-date']);

function normalizeStoryPart(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}

function normalizeStoryText(value) {
    return normalizeStoryPart(value)
        .replace(/\s+(?:\.{3}|\u2026)\s*(?:see more|see less)$/iu, '')
        .trim();
}

function isFacebookHostname(value) {
    const hostname = String(value || '')
        .toLowerCase()
        .replace(/\.$/, '');
    return hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
}

function validFacebookObjectId(value) {
    const id = String(value || '').trim();
    return /^[A-Za-z0-9._-]{1,256}$/.test(id) ? id : '';
}

function strongFacebookStoryKey(rawUrl, canonicalizeUrl) {
    let canonicalUrl = '';
    try {
        canonicalUrl = canonicalizeUrl(rawUrl || '');
        if (!canonicalUrl) return { canonicalUrl: '', strongKey: '' };

        const url = new URL(canonicalUrl);
        if (!/^https?:$/i.test(url.protocol) || !isFacebookHostname(url.hostname)) {
            return { canonicalUrl, strongKey: '' };
        }

        // `story_fbid` and `/posts/:id` are alternate Facebook spellings of the same post object.
        // A generic `fbid` may instead identify a photo/media object, so it is intentionally ignored.
        const storyId = validFacebookObjectId(url.searchParams.get('story_fbid'));
        if (storyId) return { canonicalUrl, strongKey: `url|facebook-post:${storyId}` };

        const postMatch = url.pathname.match(/\/posts\/([^/?#]+)/i);
        const postId = validFacebookObjectId(postMatch?.[1]);
        if (postId) return { canonicalUrl, strongKey: `url|facebook-post:${postId}` };

        // Watch and video URLs are alternate spellings of the same video object. Reels stay in a
        // separate namespace because an equal-looking ID is not proof that it is the same object.
        const videoMatch = url.pathname.match(/\/videos\/([^/?#]+)/i);
        const videoId = validFacebookObjectId(videoMatch?.[1]);
        if (videoId) return { canonicalUrl, strongKey: `url|facebook-video:${videoId}` };

        if (/\/watch\/?$/i.test(url.pathname)) {
            const watchId = validFacebookObjectId(url.searchParams.get('v'));
            if (watchId) return { canonicalUrl, strongKey: `url|facebook-video:${watchId}` };
        }

        const reelMatch = url.pathname.match(/\/reel\/([^/?#]+)/i);
        const reelId = validFacebookObjectId(reelMatch?.[1]);
        if (reelId) return { canonicalUrl, strongKey: `url|facebook-reel:${reelId}` };

        return { canonicalUrl, strongKey: '' };
    } catch {
        return { canonicalUrl: String(canonicalUrl || rawUrl || '').trim(), strongKey: '' };
    }
}

function acceptedIsoDay(story) {
    const raw = story?.posted_at_iso || story?.postedAtIso || story?.iso || story?.datetime || '';
    if (!raw) return '';
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/**
 * Describe one story observation without pretending that weak content evidence is a post ID.
 *
 * - `strongKey` is an exact, host-validated Facebook object identity.
 * - `contentKey` is useful for compatibility checks, never for clearing an undated ambiguity.
 * - `dayKey` is the conservative fallback for accepted, dated observations.
 */
export function describeActivityStory(story, canonicalizeUrl = DEFAULT_CANONICALIZE_URL) {
    const { canonicalUrl, strongKey } = strongFacebookStoryKey(story?.postUrl || story?.url || '', canonicalizeUrl);
    const author = normalizeStoryPart(story?.author);
    const postText = normalizeStoryText(story?.postText);
    const day = acceptedIsoDay(story);
    const contentKey = author && postText ? `story-content|${JSON.stringify([author, postText])}` : '';
    const dayKey = contentKey && day ? `story-day|${day}|${contentKey}` : '';

    return {
        canonicalUrl,
        strongKey,
        contentKey,
        day,
        dayKey,
    };
}

/**
 * A captionless photo post can still be strong activity evidence when Facebook exposes an exact
 * post object, a dated story timestamp, and a separately verified author match. Keep this limited
 * to ordinary post/permalink identities: reel/video duration labels such as "06m" must not become
 * trusted timestamps merely because the media has its own URL.
 */
export function canAcceptCaptionlessPostObservation(
    story,
    { authorMatches = false, canonicalizeUrl = DEFAULT_CANONICALIZE_URL } = {},
) {
    const descriptor = describeActivityStory(story, canonicalizeUrl);
    const rawDate = story?.posted_at_raw || story?.postedAtRaw || story?.postDate || '';
    return Boolean(
        !normalizeStoryText(story?.postText) &&
        /^url\|facebook-post:/.test(descriptor.strongKey) &&
        descriptor.day &&
        String(rawDate).trim() &&
        authorMatches,
    );
}

/** Backward-compatible single-key view for hover-attempt bookkeeping. */
export function activityStoryFingerprint(story, canonicalizeUrl = DEFAULT_CANONICALIZE_URL) {
    const descriptor = describeActivityStory(story, canonicalizeUrl);
    return descriptor.strongKey || descriptor.contentKey;
}

export function isStrongActivityStoryFingerprint(value) {
    return /^url\|facebook-(?:post|reel|video):[A-Za-z0-9._-]+$/.test(String(value || ''));
}

export function findUnresolvedVerifiedActivityStories(
    verifiedStories,
    cards,
    canonicalizeUrl = DEFAULT_CANONICALIZE_URL,
) {
    const observations = Array.isArray(cards) ? cards : [];
    const resolvedOrders = new Set(
        observations.map((card) => card?.storyOrder).filter((value) => Number.isSafeInteger(value) && value >= 0),
    );
    const resolvedStrongKeys = new Set(
        observations.map((card) => describeActivityStory(card, canonicalizeUrl).strongKey).filter(Boolean),
    );

    return (Array.isArray(verifiedStories) ? verifiedStories : []).filter((story) => {
        if (resolvedOrders.has(story?.storyOrder)) return false;
        const { strongKey } = describeActivityStory(story, canonicalizeUrl);
        return !strongKey || !resolvedStrongKeys.has(strongKey);
    });
}

function timestampEvidenceRank(observation) {
    const source = String(observation?.time_source || observation?.timeSource || '').toLowerCase();
    if (/(?:^|-)(?:time)(?:$|-)/.test(source)) return 4;
    if (/(?:^|-)(?:epoch)(?:$|-)/.test(source)) return 3;
    if (/(?:^|-)(?:aria)(?:$|-)/.test(source)) return 2;
    return observation?.posted_at_iso ? 1 : 0;
}

function selectCanonicalObservation(entries) {
    const ranked = [...entries].sort((left, right) => {
        const timestampDelta = timestampEvidenceRank(right.observation) - timestampEvidenceRank(left.observation);
        if (timestampDelta) return timestampDelta;
        const strongUrlDelta = Number(Boolean(right.descriptor.strongKey)) - Number(Boolean(left.descriptor.strongKey));
        if (strongUrlDelta) return strongUrlDelta;
        const rightPostedAtMs = Date.parse(right.observation?.posted_at_iso || '');
        const leftPostedAtMs = Date.parse(left.observation?.posted_at_iso || '');
        const rightHasValidPostedAt = Number.isFinite(rightPostedAtMs);
        const leftHasValidPostedAt = Number.isFinite(leftPostedAtMs);
        if (rightHasValidPostedAt !== leftHasValidPostedAt) return rightHasValidPostedAt ? 1 : -1;
        if (rightHasValidPostedAt && rightPostedAtMs !== leftPostedAtMs) {
            return rightPostedAtMs - leftPostedAtMs;
        }
        return left.index - right.index;
    });
    const timestampEntry = ranked[0];
    const permalinkEntry = entries.find((entry) => entry.descriptor.strongKey && entry.descriptor.canonicalUrl);
    const contentEntry = [...entries].sort(
        (left, right) =>
            String(right.observation?.postText || '').length - String(left.observation?.postText || '').length ||
            left.index - right.index,
    )[0];

    return {
        ...timestampEntry.observation,
        postUrl:
            permalinkEntry?.descriptor.canonicalUrl ||
            timestampEntry.descriptor.canonicalUrl ||
            timestampEntry.observation?.postUrl ||
            '',
        author: contentEntry?.observation?.author || timestampEntry.observation?.author || null,
        postText: contentEntry?.observation?.postText || timestampEntry.observation?.postText || null,
        storyScoped: entries.some((entry) => entry.observation?.storyScoped === true),
    };
}

function canonicalObservationSort(left, right) {
    const rightMs = Date.parse(right?.posted_at_iso || '');
    const leftMs = Date.parse(left?.posted_at_iso || '');
    return (Number.isFinite(rightMs) ? rightMs : -Infinity) - (Number.isFinite(leftMs) ? leftMs : -Infinity);
}

/**
 * Canonicalize accepted, dated observations without collapsing different strong Facebook IDs.
 *
 * A URL-less observation may join a strong group only when its author+full-text+day alias points to
 * exactly one strong group. A collision is reported and omitted rather than guessed. Groups whose
 * exact strong identity has conflicting dates/content are also omitted from trusted output.
 */
export function canonicalizeAcceptedActivityObservations(
    observations,
    { canonicalizeUrl = DEFAULT_CANONICALIZE_URL, maxResults = Infinity } = {},
) {
    const entries = (Array.isArray(observations) ? observations : [])
        .filter((observation) => observation && typeof observation === 'object')
        .map((observation, index) => ({
            observation,
            index,
            descriptor: describeActivityStory(observation, canonicalizeUrl),
        }));
    const conflicts = [];
    const strongGroups = new Map();
    const weakEntries = [];

    for (const entry of entries) {
        const { strongKey, contentKey, dayKey } = entry.descriptor;
        if (strongKey) {
            if (!entry.descriptor.day) {
                conflicts.push({
                    reason: 'accepted-missing-day-identity',
                    strongKey,
                });
                continue;
            }
            if (!strongGroups.has(strongKey)) strongGroups.set(strongKey, []);
            strongGroups.get(strongKey).push(entry);
            continue;
        }
        if (!contentKey || !dayKey) {
            conflicts.push({
                reason: !contentKey ? 'accepted-missing-content-identity' : 'accepted-missing-day-identity',
                strongKey: null,
            });
            continue;
        }
        weakEntries.push(entry);
    }

    const strongKeysByDayKey = new Map();
    for (const [strongKey, groupEntries] of strongGroups) {
        for (const entry of groupEntries) {
            const { dayKey } = entry.descriptor;
            if (!strongKeysByDayKey.has(dayKey)) strongKeysByDayKey.set(dayKey, new Set());
            strongKeysByDayKey.get(dayKey).add(strongKey);
        }
    }

    const groups = new Map(Array.from(strongGroups, ([strongKey, groupEntries]) => [strongKey, [...groupEntries]]));
    for (const entry of weakEntries) {
        const matchingStrongKeys = strongKeysByDayKey.get(entry.descriptor.dayKey) || new Set();
        if (matchingStrongKeys.size > 1) {
            conflicts.push({
                reason: 'weak-alias-matches-multiple-strong-identities',
                dayKey: entry.descriptor.dayKey,
                strongKeys: Array.from(matchingStrongKeys).sort(),
            });
            continue;
        }
        const canonicalKey =
            matchingStrongKeys.size === 1
                ? matchingStrongKeys.values().next().value
                : `weak|${entry.descriptor.dayKey}`;
        if (!groups.has(canonicalKey)) groups.set(canonicalKey, []);
        groups.get(canonicalKey).push(entry);
    }

    const canonicalPosts = [];
    const acceptedEvidence = [];
    for (const [canonicalKey, groupEntries] of groups) {
        const days = new Set(groupEntries.map((entry) => entry.descriptor.day).filter(Boolean));
        const contentKeys = new Set(groupEntries.map((entry) => entry.descriptor.contentKey).filter(Boolean));
        let groupConflict = false;
        if (canonicalKey.startsWith('url|') && days.size > 1) {
            conflicts.push({
                reason: 'strong-identity-date-conflict',
                strongKey: canonicalKey,
                days: Array.from(days).sort(),
            });
            groupConflict = true;
        }
        if (canonicalKey.startsWith('url|') && contentKeys.size > 1) {
            conflicts.push({
                reason: 'strong-identity-content-conflict',
                strongKey: canonicalKey,
            });
            groupConflict = true;
        }
        if (groupConflict) continue;

        const post = selectCanonicalObservation(groupEntries);
        const descriptor = describeActivityStory(post, canonicalizeUrl);
        canonicalPosts.push(post);
        acceptedEvidence.push(descriptor);
    }

    canonicalPosts.sort(canonicalObservationSort);
    const numericLimit = Number(maxResults);
    const limit = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : Infinity;

    return {
        posts: canonicalPosts.slice(0, limit),
        uniqueCount: canonicalPosts.length,
        acceptedEvidence,
        conflicts,
    };
}

export function shouldCorroborateInactiveActivity({
    primaryScanComplete,
    reuseTargetPageForFeed,
    skipInactiveEnrichment,
    feedReady,
    wouldBeInactive,
}) {
    return Boolean(
        primaryScanComplete && reuseTargetPageForFeed && skipInactiveEnrichment && feedReady && wouldBeInactive,
    );
}

function normalizeAcceptedEvidence(value) {
    if (typeof value === 'string') {
        return {
            strongKey: isStrongActivityStoryFingerprint(value) ? value : '',
            contentKey: isStrongActivityStoryFingerprint(value) ? '' : value,
            day: '',
            dayKey: '',
        };
    }
    const candidate = value?.descriptor || value || {};
    return {
        strongKey: isStrongActivityStoryFingerprint(candidate.strongKey) ? candidate.strongKey : '',
        contentKey: String(candidate.contentKey || ''),
        day: String(candidate.day || ''),
        dayKey: String(candidate.dayKey || ''),
    };
}

function normalizeAmbiguousEvidence(value) {
    if (typeof value === 'string') {
        const accepted = normalizeAcceptedEvidence(value);
        return { ...accepted, reason: 'legacy-unknown' };
    }
    const candidate = value?.descriptor || value || {};
    return {
        ...normalizeAcceptedEvidence(candidate),
        reason: String(value?.reason || candidate.reason || 'unknown').toLowerCase(),
    };
}

function countCanonicalAcceptedEvidence(accepted) {
    const strongKeys = new Set(accepted.map((item) => item.strongKey).filter(Boolean));
    const strongKeysByDayKey = new Map();
    for (const item of accepted) {
        if (!item.strongKey || !item.dayKey) continue;
        if (!strongKeysByDayKey.has(item.dayKey)) strongKeysByDayKey.set(item.dayKey, new Set());
        strongKeysByDayKey.get(item.dayKey).add(item.strongKey);
    }

    const canonicalKeys = new Set(strongKeys);
    for (const item of accepted) {
        if (item.strongKey) continue;
        const matching = strongKeysByDayKey.get(item.dayKey) || new Set();
        if (matching.size === 1) canonicalKeys.add(matching.values().next().value);
        else if (item.dayKey) canonicalKeys.add(`weak|${item.dayKey}`);
        else if (item.contentKey) canonicalKeys.add(`legacy-weak|${item.contentKey}`);
    }
    return canonicalKeys.size;
}

/**
 * Reconcile scan completeness. Only a missing/unparseable timestamp with the same exact Facebook
 * identity and the same normalized author+text may be cleared. Future/conflicting evidence and
 * legacy string ambiguities always fail closed.
 */
export function reconcileActivityScanEvidence(reads) {
    const scans = Array.isArray(reads) ? reads.filter(Boolean) : [];
    const accepted = scans.flatMap((read) =>
        (read?.evidenceFingerprints?.accepted || []).map(normalizeAcceptedEvidence),
    );
    const ambiguous = scans.flatMap((read) =>
        (read?.evidenceFingerprints?.ambiguous || []).map(normalizeAmbiguousEvidence),
    );
    const conflicts = scans.flatMap((read) => [
        ...(Array.isArray(read?.reconciliationConflicts) ? read.reconciliationConflicts : []),
        ...(Array.isArray(read?.canonicalization?.conflicts) ? read.canonicalization.conflicts : []),
    ]);

    const acceptedByStrongKey = new Map();
    for (const item of accepted) {
        if (!item.strongKey) continue;
        if (!acceptedByStrongKey.has(item.strongKey)) acceptedByStrongKey.set(item.strongKey, []);
        acceptedByStrongKey.get(item.strongKey).push(item);
    }

    for (const [strongKey, items] of acceptedByStrongKey) {
        const days = new Set(items.map((item) => item.day).filter(Boolean));
        const contentKeys = new Set(items.map((item) => item.contentKey).filter(Boolean));
        if (days.size > 1) {
            conflicts.push({
                reason: 'strong-identity-date-conflict',
                strongKey,
                days: Array.from(days).sort(),
            });
        }
        if (contentKeys.size > 1) {
            conflicts.push({ reason: 'strong-identity-content-conflict', strongKey });
        }
    }

    const acceptedStrongKeysByDayKey = new Map();
    for (const item of accepted) {
        if (!item.strongKey || !item.dayKey) continue;
        if (!acceptedStrongKeysByDayKey.has(item.dayKey)) {
            acceptedStrongKeysByDayKey.set(item.dayKey, new Set());
        }
        acceptedStrongKeysByDayKey.get(item.dayKey).add(item.strongKey);
    }
    for (const item of accepted) {
        if (item.strongKey || !item.dayKey) continue;
        const matchingStrongKeys = acceptedStrongKeysByDayKey.get(item.dayKey) || new Set();
        if (matchingStrongKeys.size > 1) {
            conflicts.push({
                reason: 'weak-alias-matches-multiple-strong-identities',
                dayKey: item.dayKey,
                strongKeys: Array.from(matchingStrongKeys).sort(),
            });
        }
    }

    const unresolved = [];
    let resolvedAmbiguousCount = 0;
    for (const item of ambiguous) {
        const candidates = acceptedByStrongKey.get(item.strongKey) || [];
        const reasonCanResolve = RESOLVABLE_AMBIGUITY_REASONS.has(item.reason);
        const compatibleAccepted = candidates.some(
            (candidate) => item.contentKey && candidate.contentKey && item.contentKey === candidate.contentKey,
        );
        if (
            item.strongKey &&
            reasonCanResolve &&
            compatibleAccepted &&
            !conflicts.some((conflict) => conflict?.strongKey === item.strongKey)
        ) {
            resolvedAmbiguousCount += 1;
        } else {
            unresolved.push(item);
        }
    }

    const acceptedCount = countCanonicalAcceptedEvidence(accepted);
    return {
        complete:
            scans.length > 0 &&
            scans.every((read) => read.boundedComplete === true) &&
            acceptedCount > 0 &&
            unresolved.length === 0 &&
            conflicts.length === 0,
        acceptedCount,
        resolvedAmbiguousCount,
        unresolvedAmbiguousCount: unresolved.length,
        conflictCount: conflicts.length,
        conflicts,
    };
}
