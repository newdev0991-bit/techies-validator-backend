import assert from 'node:assert/strict';
import test from 'node:test';

import {
    activityStoryFingerprint,
    canAcceptCaptionlessPostObservation,
    canonicalizeAcceptedActivityObservations,
    describeActivityStory,
    findUnresolvedVerifiedActivityStories,
    isStrongActivityStoryFingerprint,
    reconcileActivityScanEvidence,
    shouldCorroborateInactiveActivity,
} from '../src/activityScanPolicy.js';

const identityCanonicalizer = (value) => value;
const readyInactiveScan = {
    primaryScanComplete: true,
    reuseTargetPageForFeed: true,
    skipInactiveEnrichment: true,
    feedReady: true,
    wouldBeInactive: true,
};

function observation({
    postUrl = 'https://www.facebook.com/example',
    date = '2026-01-21T00:00:00.000Z',
    rawDate = 'January 21, 2026',
    source = 'feed-aria',
    author = 'Example Salon',
    postText = 'Our summer offer',
} = {}) {
    return {
        postUrl,
        posted_at_iso: date,
        posted_at_raw: rawDate,
        time_source: source,
        author,
        postText,
        storyScoped: true,
    };
}

function read({ accepted = [], ambiguous = [], boundedComplete = true, conflicts = [] } = {}) {
    return {
        boundedComplete,
        evidenceFingerprints: { accepted, ambiguous },
        reconciliationConflicts: conflicts,
    };
}

test('corroborates only a complete inactive bare-page scan', () => {
    assert.equal(shouldCorroborateInactiveActivity(readyInactiveScan), true);

    for (const key of Object.keys(readyInactiveScan)) {
        assert.equal(
            shouldCorroborateInactiveActivity({ ...readyInactiveScan, [key]: false }),
            false,
            `${key}=false must prevent corroboration`,
        );
    }
});

test('normalizes only proved equivalent Facebook post and video URL forms', () => {
    const postPath = activityStoryFingerprint(
        {
            postUrl: 'https://www.facebook.com/example/posts/pfbidAbC123',
            author: 'A',
            postText: 'B',
        },
        identityCanonicalizer,
    );
    const postQuery = activityStoryFingerprint(
        {
            postUrl: 'https://m.facebook.com/permalink.php?story_fbid=pfbidAbC123&id=999',
            author: 'A',
            postText: 'B',
        },
        identityCanonicalizer,
    );
    const videoPath = activityStoryFingerprint(
        {
            postUrl: 'https://www.facebook.com/example/videos/777',
            author: 'A',
            postText: 'B',
        },
        identityCanonicalizer,
    );
    const watchQuery = activityStoryFingerprint(
        {
            postUrl: 'https://www.facebook.com/watch/?v=777',
            author: 'A',
            postText: 'B',
        },
        identityCanonicalizer,
    );

    assert.equal(postPath, 'url|facebook-post:pfbidAbC123');
    assert.equal(postQuery, postPath);
    assert.equal(videoPath, 'url|facebook-video:777');
    assert.equal(watchQuery, videoPath);
});

test('preserves opaque ID case and keeps Facebook object namespaces separate', () => {
    const upper = describeActivityStory(
        { postUrl: 'https://www.facebook.com/example/posts/pfbidAbC', author: 'A', postText: 'B' },
        identityCanonicalizer,
    );
    const lower = describeActivityStory(
        { postUrl: 'https://www.facebook.com/example/posts/pfbidabc', author: 'A', postText: 'B' },
        identityCanonicalizer,
    );
    const reel = describeActivityStory(
        { postUrl: 'https://www.facebook.com/reel/123', author: 'A', postText: 'B' },
        identityCanonicalizer,
    );
    const post = describeActivityStory(
        { postUrl: 'https://www.facebook.com/example/posts/123', author: 'A', postText: 'B' },
        identityCanonicalizer,
    );
    const video = describeActivityStory(
        { postUrl: 'https://www.facebook.com/example/videos/123', author: 'A', postText: 'B' },
        identityCanonicalizer,
    );

    assert.notEqual(upper.strongKey, lower.strongKey);
    assert.equal(reel.strongKey, 'url|facebook-reel:123');
    assert.equal(post.strongKey, 'url|facebook-post:123');
    assert.equal(video.strongKey, 'url|facebook-video:123');
    assert.equal(new Set([reel.strongKey, post.strongKey, video.strongKey]).size, 3);
});

test('rejects external lookalike URLs and generic photo fbid as strong identities', () => {
    const external = describeActivityStory(
        { postUrl: 'https://example.com/posts/123', author: 'A', postText: 'B' },
        identityCanonicalizer,
    );
    const photo = describeActivityStory(
        {
            postUrl: 'https://www.facebook.com/photo.php?fbid=123',
            author: 'A',
            postText: 'B',
        },
        identityCanonicalizer,
    );

    assert.equal(external.strongKey, '');
    assert.equal(photo.strongKey, '');
    assert.equal(
        isStrongActivityStoryFingerprint(
            activityStoryFingerprint(
                { postUrl: 'https://example.com/posts/123', author: 'A', postText: 'B' },
                identityCanonicalizer,
            ),
        ),
        false,
    );
    assert.equal(
        isStrongActivityStoryFingerprint(
            activityStoryFingerprint(
                {
                    postUrl: 'https://www.facebook.com/photo.php?fbid=123',
                    author: 'A',
                    postText: 'B',
                },
                identityCanonicalizer,
            ),
        ),
        false,
    );
});

test('content aliases normalize Unicode, whitespace, and an explicit See more UI suffix', () => {
    const left = describeActivityStory(
        { author: '  Caf\u00e9\u00a0Salon ', postText: 'Big\t sale \u2026 See more' },
        identityCanonicalizer,
    );
    const right = describeActivityStory({ author: 'caf\u00e9 salon', postText: 'big sale' }, identityCanonicalizer);
    const punctuationDiffers = describeActivityStory(
        { author: 'caf\u00e9 salon', postText: 'big-sale' },
        identityCanonicalizer,
    );

    assert.equal(left.contentKey, right.contentKey);
    assert.notEqual(right.contentKey, punctuationDiffers.contentKey);
});

test('accepts a captionless dated photo post only with an exact post identity and author match', () => {
    const leahPost = {
        postUrl: 'https://www.facebook.com/LeahRoseHairAndBeautyWoking/posts/pfbid035D9BqCgqVEQJ2X2AUTVVZfbe1',
        posted_at_raw: '9m',
        posted_at_iso: '2026-08-22T21:39:28.559Z',
        postText: null,
    };

    assert.equal(
        canAcceptCaptionlessPostObservation(leahPost, {
            authorMatches: true,
            canonicalizeUrl: identityCanonicalizer,
        }),
        true,
    );
    for (const candidate of [
        { ...leahPost, postUrl: 'https://www.facebook.com/reel/123' },
        { ...leahPost, postUrl: 'https://www.facebook.com/example/videos/123' },
        { ...leahPost, postUrl: 'https://www.facebook.com/example' },
    ]) {
        assert.equal(
            canAcceptCaptionlessPostObservation(candidate, {
                authorMatches: true,
                canonicalizeUrl: identityCanonicalizer,
            }),
            false,
        );
    }
    assert.equal(
        canAcceptCaptionlessPostObservation(leahPost, {
            authorMatches: false,
            canonicalizeUrl: identityCanonicalizer,
        }),
        false,
    );
});

test('mixed dated and undated verified stories keep the undated story unresolved', () => {
    const verified = [
        {
            storyOrder: 0,
            postUrl: 'https://www.facebook.com/example/posts/111',
            author: 'Example Salon',
            postText: 'First story',
        },
        {
            storyOrder: 1,
            author: 'Example Salon',
            postText: 'Possibly newer undated story',
        },
    ];
    const datedCards = [
        {
            ...verified[0],
            posted_at_iso: '2026-01-21T00:00:00.000Z',
        },
    ];

    assert.deepEqual(findUnresolvedVerifiedActivityStories(verified, datedCards, identityCanonicalizer), [verified[1]]);
});

test('strong identity can resolve a verified story when DOM order metadata is absent', () => {
    const verified = [
        {
            storyOrder: 3,
            postUrl: 'https://www.facebook.com/example/posts/pfbidAbC',
            author: 'Example Salon',
            postText: 'A story',
        },
    ];
    const datedCards = [
        {
            postUrl: 'https://m.facebook.com/permalink.php?story_fbid=pfbidAbC&id=99',
            author: 'Example Salon',
            postText: 'A story',
            posted_at_iso: '2026-01-21T00:00:00.000Z',
        },
    ];

    assert.deepEqual(findUnresolvedVerifiedActivityStories(verified, datedCards, identityCanonicalizer), []);
});

test('canonicalizes permalink and URL-less observations of the same story', () => {
    const strong = observation({
        postUrl: 'https://www.facebook.com/example/posts/123',
        date: '2026-01-21T00:00:00.000Z',
        source: 'feed-aria',
    });
    const preciseFallback = observation({
        postUrl: 'https://www.facebook.com/example',
        date: '2026-01-21T06:49:00.000Z',
        rawDate: 'January 21, 2026 at 6:49 AM',
        source: 'feed-time',
    });
    const result = canonicalizeAcceptedActivityObservations([strong, preciseFallback], {
        canonicalizeUrl: identityCanonicalizer,
    });

    assert.equal(result.uniqueCount, 1);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].postUrl, strong.postUrl);
    assert.equal(result.posts[0].posted_at_iso, preciseFallback.posted_at_iso);
    assert.equal(result.posts[0].time_source, 'feed-time');
    assert.deepEqual(result.conflicts, []);
});

test('canonicalizes a dated strong post identity without requiring caption text', () => {
    const result = canonicalizeAcceptedActivityObservations([
        observation({
            postUrl: 'https://www.facebook.com/example/posts/123',
            date: '2026-08-22T21:39:28.559Z',
            rawDate: '9m',
            postText: '',
        }),
    ]);

    assert.equal(result.uniqueCount, 1);
    assert.equal(result.posts[0].posted_at_iso, '2026-08-22T21:39:28.559Z');
    assert.deepEqual(result.conflicts, []);
});

test('same wording on different days remains separate', () => {
    const result = canonicalizeAcceptedActivityObservations([
        observation({ date: '2026-01-21T00:00:00.000Z' }),
        observation({ date: '2026-02-21T00:00:00.000Z', rawDate: 'February 21, 2026' }),
    ]);

    assert.equal(result.uniqueCount, 2);
    assert.deepEqual(result.conflicts, []);
});

test('same weak story day and evidence rank keeps the latest valid timestamp', () => {
    const justAfterMidnight = observation({
        date: '2026-01-21T00:01:00.000Z',
        rawDate: 'January 21, 2026 at 12:01 AM',
        source: 'feed-aria',
    });
    const justBeforeMidnight = observation({
        date: '2026-01-21T23:59:00.000Z',
        rawDate: 'January 21, 2026 at 11:59 PM',
        source: 'feed-aria',
    });
    const result = canonicalizeAcceptedActivityObservations([justAfterMidnight, justBeforeMidnight]);

    assert.equal(result.uniqueCount, 1);
    assert.equal(result.posts[0].posted_at_iso, '2026-01-21T23:59:00.000Z');
    assert.equal(result.posts[0].posted_at_raw, 'January 21, 2026 at 11:59 PM');
});

test('different strong IDs with the same wording and day remain separate', () => {
    const result = canonicalizeAcceptedActivityObservations([
        observation({ postUrl: 'https://www.facebook.com/example/posts/111' }),
        observation({ postUrl: 'https://www.facebook.com/example/posts/222' }),
    ]);

    assert.equal(result.uniqueCount, 2);
    assert.deepEqual(result.conflicts, []);
});

test('a weak alias matching multiple strong IDs is reported instead of guessed', () => {
    const result = canonicalizeAcceptedActivityObservations([
        observation({ postUrl: 'https://www.facebook.com/example/posts/111' }),
        observation({ postUrl: 'https://www.facebook.com/example/posts/222' }),
        observation({ postUrl: 'https://www.facebook.com/example' }),
    ]);

    assert.equal(result.uniqueCount, 2);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].reason, 'weak-alias-matches-multiple-strong-identities');
});

test('conflicting dates for one strong identity are omitted from trusted output', () => {
    const result = canonicalizeAcceptedActivityObservations([
        observation({
            postUrl: 'https://www.facebook.com/example/posts/123',
            date: '2026-01-21T00:00:00.000Z',
        }),
        observation({
            postUrl: 'https://www.facebook.com/permalink.php?story_fbid=123&id=999',
            date: '2026-02-21T00:00:00.000Z',
            rawDate: 'February 21, 2026',
        }),
    ]);

    assert.equal(result.uniqueCount, 0);
    assert.equal(result.posts.length, 0);
    assert.equal(result.conflicts[0].reason, 'strong-identity-date-conflict');
});

test('reconciles a missing date only with compatible content and exact strong identity', () => {
    const accepted = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/123' }),
        identityCanonicalizer,
    );
    const ambiguous = describeActivityStory(
        {
            postUrl: 'https://www.facebook.com/permalink.php?story_fbid=123&id=999',
            author: 'Example Salon',
            postText: 'Our summer offer',
        },
        identityCanonicalizer,
    );
    const result = reconcileActivityScanEvidence([
        read({ accepted: [accepted] }),
        read({ ambiguous: [{ ...ambiguous, reason: 'missing-date' }] }),
    ]);

    assert.equal(result.complete, true);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.resolvedAmbiguousCount, 1);
    assert.equal(result.unresolvedAmbiguousCount, 0);
    assert.equal(result.conflictCount, 0);
});

test('future evidence never resolves against an accepted old observation', () => {
    const accepted = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/123' }),
        identityCanonicalizer,
    );
    const ambiguous = describeActivityStory(
        {
            postUrl: 'https://www.facebook.com/example/posts/123',
            author: 'Example Salon',
            postText: 'Our summer offer',
        },
        identityCanonicalizer,
    );
    const result = reconcileActivityScanEvidence([
        read({ accepted: [accepted] }),
        read({ ambiguous: [{ ...ambiguous, reason: 'future-date' }] }),
    ]);

    assert.equal(result.complete, false);
    assert.equal(result.unresolvedAmbiguousCount, 1);
});

test('same strong identity with incompatible content cannot clear an ambiguity', () => {
    const accepted = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/123' }),
        identityCanonicalizer,
    );
    const ambiguous = describeActivityStory(
        {
            postUrl: 'https://www.facebook.com/example/posts/123',
            author: 'Example Salon',
            postText: 'A different story',
        },
        identityCanonicalizer,
    );
    const result = reconcileActivityScanEvidence([
        read({ accepted: [accepted] }),
        read({ ambiguous: [{ ...ambiguous, reason: 'missing-date' }] }),
    ]);

    assert.equal(result.complete, false);
    assert.equal(result.unresolvedAmbiguousCount, 1);
});

test('content-only and legacy string ambiguities stay unresolved', () => {
    const weak = describeActivityStory(
        { author: 'Example Salon', postText: 'Our summer offer' },
        identityCanonicalizer,
    );
    const weakResult = reconcileActivityScanEvidence([
        read({ accepted: [weak] }),
        read({ ambiguous: [{ ...weak, reason: 'missing-date' }] }),
    ]);
    const legacyResult = reconcileActivityScanEvidence([
        read({ accepted: ['url|facebook-post:123'] }),
        read({ ambiguous: ['url|facebook-post:123'] }),
    ]);

    assert.equal(weakResult.complete, false);
    assert.equal(weakResult.unresolvedAmbiguousCount, 1);
    assert.equal(legacyResult.complete, false);
    assert.equal(legacyResult.unresolvedAmbiguousCount, 1);
});

test('an unkeyed media-only verified story remains unresolved', () => {
    const accepted = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/123' }),
        identityCanonicalizer,
    );
    const result = reconcileActivityScanEvidence([
        read({
            accepted: [accepted],
            ambiguous: [
                {
                    strongKey: '',
                    contentKey: '',
                    day: '',
                    dayKey: '',
                    reason: 'missing-timestamp',
                },
            ],
        }),
    ]);

    assert.equal(result.complete, false);
    assert.equal(result.unresolvedAmbiguousCount, 1);
});

test('accepted observations with the same strong identity but different days conflict', () => {
    const first = describeActivityStory(
        observation({
            postUrl: 'https://www.facebook.com/example/posts/123',
            date: '2026-01-21T00:00:00.000Z',
        }),
        identityCanonicalizer,
    );
    const second = describeActivityStory(
        observation({
            postUrl: 'https://www.facebook.com/permalink.php?story_fbid=123&id=999',
            date: '2026-02-21T00:00:00.000Z',
        }),
        identityCanonicalizer,
    );
    const result = reconcileActivityScanEvidence([read({ accepted: [first] }), read({ accepted: [second] })]);

    assert.equal(result.complete, false);
    assert.equal(result.conflictCount, 1);
    assert.equal(result.conflicts[0].reason, 'strong-identity-date-conflict');
});

test('an exhausted scan or explicit canonicalization conflict cannot reconcile complete', () => {
    const accepted = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/123' }),
        identityCanonicalizer,
    );
    const exhausted = reconcileActivityScanEvidence([read({ accepted: [accepted], boundedComplete: false })]);
    const conflicted = reconcileActivityScanEvidence([
        read({
            accepted: [accepted],
            conflicts: [{ reason: 'weak-alias-matches-multiple-strong-identities' }],
        }),
    ]);

    assert.equal(exhausted.complete, false);
    assert.equal(conflicted.complete, false);
    assert.equal(conflicted.conflictCount, 1);
});

test('an empty bounded scan and an ambiguous weak-to-strong alias collision fail closed', () => {
    const empty = reconcileActivityScanEvidence([read()]);
    const first = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/111' }),
        identityCanonicalizer,
    );
    const second = describeActivityStory(
        observation({ postUrl: 'https://www.facebook.com/example/posts/222' }),
        identityCanonicalizer,
    );
    const weak = describeActivityStory(observation(), identityCanonicalizer);
    const collision = reconcileActivityScanEvidence([read({ accepted: [first, second, weak] })]);

    assert.equal(empty.complete, false);
    assert.equal(empty.acceptedCount, 0);
    assert.equal(collision.complete, false);
    assert.equal(collision.conflicts[0].reason, 'weak-alias-matches-multiple-strong-identities');
});
