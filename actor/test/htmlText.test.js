import assert from 'node:assert/strict';
import test from 'node:test';

import { htmlToVisibleText, readHtmlAnchors, readHtmlTitle } from '../src/htmlText.js';

const GOOGLE_BASE = 'http://www.google.com';

test('a result link is read however much markup its anchor wraps', () => {
    // A Google result anchor wraps its title, snippet and sitelinks. Bounding the whole anchor
    // rather than just its text is what made a 335 KB results page yield 23 links.
    const bulky = '<div>'.concat('snippet text '.repeat(120), '</div>');
    const html = `
        <a href="/url?q=https://short.example">short</a>
        <a href="/url?q=https://bulky.example"><h3>Bulky Result</h3>${bulky}</a>
    `;

    const hrefs = readHtmlAnchors(html, GOOGLE_BASE).map((anchor) => anchor.href);

    assert.ok(hrefs.some((href) => href.includes('bulky.example')));
    assert.ok(hrefs.some((href) => href.includes('short.example')));
});

test('anchor text is captured for links that carry it and bounded for links that run long', () => {
    const html = `<a href="/contact">Contact Us</a><a href="/x">${'y'.repeat(5000)}</a>`;

    const [contact, long] = readHtmlAnchors(html, 'https://example.com');

    assert.equal(contact.text, 'Contact Us');
    assert.equal(contact.href, 'https://example.com/contact');
    assert.ok(long.text.length <= 2000);
});

test('hrefs are read from single quotes and bare attributes as well as double quotes', () => {
    const html = `<a href='/single'>a</a><a href=/bare>b</a><a href="/double">c</a>`;

    const paths = readHtmlAnchors(html, 'https://example.com').map((anchor) => new URL(anchor.href).pathname);

    assert.deepEqual(paths, ['/single', '/bare', '/double']);
});

test('mailto and tel links survive verbatim instead of being resolved against the page', () => {
    const html = '<a href="mailto:hi@example.com">Email</a><a href="tel:+441234567890">Call</a>';

    const hrefs = readHtmlAnchors(html, 'https://example.com').map((anchor) => anchor.href);

    assert.deepEqual(hrefs, ['mailto:hi@example.com', 'tel:+441234567890']);
});

test('an anchor with no href contributes nothing rather than a resolved page URL', () => {
    assert.deepEqual(readHtmlAnchors('<a name="top">anchor</a>', 'https://example.com'), []);
});

test('script and style bodies stay out of the visible text an identity match reads', () => {
    const html = `
        <script>var owner = "Some Other Business";</script>
        <style>.a{content:"Also Not This"}</style>
        <p>Riya Hair &amp; Beauty</p><div>96a Staines Road</div>
    `;

    const text = htmlToVisibleText(html);

    assert.match(text, /Riya Hair & Beauty/);
    assert.match(text, /96a Staines Road/);
    assert.doesNotMatch(text, /Some Other Business|Also Not This/);
});

test('the page title is read and entity-decoded', () => {
    assert.equal(readHtmlTitle('<title>Riya Hair &amp; Beauty | Hounslow</title>'), 'Riya Hair & Beauty | Hounslow');
    assert.equal(readHtmlTitle('<html><body>no title</body></html>'), '');
});
