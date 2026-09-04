import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePageUrlFromPostUrl } from '../src/cotUrls.js';

test('a group post has no owning page, so no page URL is derived', () => {
    // `/groups/<g>/posts/<id>` matches the generic `/<name>/posts/` shape, which would
    // otherwise yield the literal page "facebook.com/groups" and attribute every group
    // post to the same non-existent business.
    const derived = derivePageUrlFromPostUrl(
        'https://www.facebook.com/groups/mineheadbusinesses/posts/2986850558313406',
    );

    assert.equal(derived, null);
});

test('a numeric group id is refused for the same reason', () => {
    assert.equal(
        derivePageUrlFromPostUrl('https://www.facebook.com/groups/957047307726190/posts/27965466063124282'),
        null,
    );
});

test('a page post still derives its owning page', () => {
    assert.equal(
        derivePageUrlFromPostUrl('https://www.facebook.com/glentonholidays/posts/pfbid0JqHWtUb'),
        'https://www.facebook.com/glentonholidays',
    );
});

test('a share link is refused like a group link', () => {
    assert.equal(derivePageUrlFromPostUrl('https://www.facebook.com/share/posts/123456'), null);
});

test('a profile permalink keeps deriving its profile page', () => {
    assert.equal(
        derivePageUrlFromPostUrl('https://www.facebook.com/profile.php?id=61592490861691&sk=posts'),
        'https://www.facebook.com/profile.php?id=61592490861691',
    );
});
