import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTimelineEdge,TIMELINE_TIME_SOURCE } from '../src/facebookTimelineFeed.js';

// `null` omits a field entirely, which is how Facebook sends a captionless or undated edge.
const buildEdge = ({
    creationTime = 1787500000,
    url = 'https://www.facebook.com/acme/posts/pfbid123',
    text = 'Open late tonight',
} = {}) => ({
    node: {
        post_id: '1234567890',
        comet_sections: {
            content: {
                story: {
                    ...(creationTime === null ? {} : { creation_time: creationTime }),
                    ...(url === null ? {} : { url }),
                    comet_sections: {
                        message: { story: { message: text === null ? {} : { text } } },
                    },
                },
            },
            context_layout: {
                story: {
                    comet_sections: {
                        actor_photo: {
                            story: {
                                actors: [{ name: 'Acme Salon', id: '999', url: 'https://www.facebook.com/acme' }],
                            },
                        },
                    },
                },
            },
        },
    },
});

test('a timeline edge becomes an activity post with a server-epoch timestamp', () => {
    const post = parseTimelineEdge(buildEdge());

    assert.equal(post.posted_at_iso, new Date(1787500000 * 1000).toISOString());
    assert.equal(post.time_source, TIMELINE_TIME_SOURCE);
    assert.equal(post.postUrl, 'https://www.facebook.com/acme/posts/pfbid123');
    assert.equal(post.author, 'Acme Salon');
    assert.equal(post.postText, 'Open late tonight');
    assert.equal(post.storyScoped, true);
});

test('the permalink comes from the story that carries the timestamp, not any other linked story', () => {
    const edge = buildEdge();
    edge.node.comet_sections.attachment = {
        story: { url: 'https://www.facebook.com/photo/?fbid=555' },
    };

    assert.equal(parseTimelineEdge(edge).postUrl, 'https://www.facebook.com/acme/posts/pfbid123');
});

test('an edge without a resolvable timestamp is rejected rather than dated from now', () => {
    assert.equal(parseTimelineEdge(buildEdge({ creationTime: null })), null);
    assert.equal(parseTimelineEdge(buildEdge({ creationTime: 1 })), null);
    assert.equal(parseTimelineEdge({ node: {} }), null);
});

test('an edge without a permalink is rejected so it cannot become unattributable evidence', () => {
    assert.equal(parseTimelineEdge(buildEdge({ url: null })), null);
});

test('a captionless post keeps its date and author instead of being dropped', () => {
    const post = parseTimelineEdge(buildEdge({ text: null }));

    assert.equal(post.postText, '');
    assert.equal(post.author, 'Acme Salon');
    assert.ok(post.posted_at_iso);
});
