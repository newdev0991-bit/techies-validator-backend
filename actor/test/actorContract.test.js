import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSourceUrl = new URL('../src/main.js', import.meta.url);
const inputSchemaUrl = new URL('../.actor/input_schema.json', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);

const readMain = () => readFile(mainSourceUrl, 'utf8');

test('every Actor output declares the stable batch contract and activity metadata shape', async () => {
    const source = await readMain();

    assert.match(source, /contractVersion:\s*'card-data-batch-v1'/);
    assert.match(source, /status:\s*'page-identity-matched'/);
    assert.match(source, /status:\s*'story-author-matched'/);
    assert.match(source, /status:\s*'unverified'/);
    assert.match(source, /attempted:\s*result\.activityScanAttempted === true/);
    assert.match(
        source,
        /complete:\s*result\.activityScanComplete === true &&\s*!warning &&\s*rejectedActivityEvidence\.length === 0/,
    );
    assert.match(source, /trustedCount:\s*qualifyingPosts\.length/);
    assert.match(source, /rejectedCount:\s*rejectedActivityEvidence\.length/);
});

test('inactive shortcut shares final-output evidence policy and uses an exact millisecond boundary', async () => {
    const source = await readMain();
    const shortcutStart = source.indexOf('function isDefinitelyOutsideActivityWindow');
    const outputStart = source.indexOf('function toCardDataOutput', shortcutStart);
    const shortcut = source.slice(shortcutStart, outputStart);

    assert.match(shortcut, /evaluateActivityEvidence\(result, input, activityWindowDays, now\)/);
    assert.match(shortcut, /activity\.scan\.complete/);
    assert.match(shortcut, /activity\.ageMs > activity\.activityWindowMs/);
    assert.doesNotMatch(shortcut, /daysBetween|Math\.floor/);
});

test('public proof is read and page evidence applied before the inactive shortcut', async () => {
    const source = await readMain();
    const evidenceRead = source.indexOf('applyPageEvidence(result, extractPageEvidence(session.html)');
    const activityRead = source.indexOf('await readCotProof(url, {');
    const shortcutCall = source.indexOf('isDefinitelyOutsideActivityWindow(result, scopedInput');

    assert.ok(activityRead >= 0 && activityRead < evidenceRead);
    assert.ok(evidenceRead < shortcutCall);
});

test('final activity normalization and permalink trust use canonical Facebook identities', async () => {
    const source = await readMain();
    const mergeStart = source.indexOf('function mergeRecentActivityEvidence');
    const evidenceStart = source.indexOf('function evaluateActivityEvidence', mergeStart);
    const evidencePolicy = source.slice(mergeStart, evidenceStart);

    assert.match(evidencePolicy, /canonicalizeAcceptedActivityObservations\(observations/);
    assert.match(evidencePolicy, /describeActivityStory\(\{ postUrl: url \}, canonicalizeFacebookUrl\)\.strongKey/);
    assert.match(evidencePolicy, /function normalizeActivityPosts/);
    assert.match(evidencePolicy, /post\.posted_at_iso \|\| post\.posted_at_raw \|\| post\.postDate/);

    const evaluationEnd = source.indexOf('function isDefinitelyOutsideActivityWindow', evidenceStart);
    const evaluation = source.slice(evidenceStart, evaluationEnd);
    assert.match(evaluation, /const recentPosts = normalizedActivity\.posts/);
    assert.match(evaluation, /activity-canonicalization-conflict:/);
    assert.match(evaluation, /conflictCount: normalizedActivity\.conflicts\.length/);
    assert.match(evaluation, /rejectedActivityEvidence\.length === 0/);
    assert.doesNotMatch(source, /result\.previousPosts = posts\.filter/);
});

test('the timeline server epoch is a trusted activity source and rendered-text sources are gone', async () => {
    const source = await readMain();

    assert.match(source, /TRUSTED_ACTIVITY_SOURCES = new Set\(\[TIMELINE_TIME_SOURCE\]\)/);
    assert.doesNotMatch(source, /'feed-aria'|'dom-aria-story'/);
});

test('an empty or failed timeline is reported as an incomplete scan, never as a settled one', async () => {
    const source = await readMain();
    assert.match(source, /result\.activityScanComplete = proof\.posts\.length > 0 && !proof\.failureReason/);
    assert.match(source, /result\.activityWarning = proof\.failureReason/);
    assert.match(source, /discoveredCount: proof\.posts\.length/);
});

test('contact evidence is attributed only once the page identity itself matched', async () => {
    const source = await readMain();
    const applyStart = source.indexOf('function applyPageEvidence');
    const applyEnd = source.indexOf('function applyTargetPostEvidence', applyStart);
    const apply = source.slice(applyStart, applyEnd);

    assert.match(apply, /const attributed = identity\.identityStatus === 'matched'/);
    for (const field of ['phone', 'email', 'website', 'address']) {
        assert.match(apply, new RegExp(`result\\.${field} = attributed \\?`));
    }
});

test('every Facebook read retries on a fresh exit IP, and a settled unavailable answer does not', async () => {
    const clientSource = await readFile(new URL('../src/facebookHttpClient.js', import.meta.url), 'utf8');

    assert.match(clientSource, /const proxyUrl = newProxyUrl \? await newProxyUrl\(attemptIndex\) : null/);
    assert.match(clientSource, /reason: 'page-unavailable-logged-out'[\s\S]{0,40}\}/);
    assert.match(clientSource, /retryable: false, reason: 'page-unavailable-logged-out'/);
    assert.match(clientSource, /retryable: true, reason: 'facebook-returned-shell-page'/);
    assert.match(clientSource, /if \(outcome\.retryable === false\) return/);
});

test('batch input schema supports requests without legacy startUrls and needs no credentials', async () => {
    const schema = JSON.parse(await readFile(inputSchemaUrl, 'utf8'));

    assert.deepEqual(schema.required, []);
    assert.equal(schema.properties.cookies, undefined);
    assert.ok(schema.properties.requests.items.required.includes('requestKey'));
    assert.ok(schema.properties.requests.items.required.includes('url'));
    assert.equal(schema.properties.requests.items.properties.requestKey.minLength, 1);
    assert.equal(schema.properties.maxRequestRetries.minimum, 1);
});

test('Google fallback has a terminal-row guard for auth blocks and row errors', async () => {
    const source = await readMain();
    const fallbackStart = source.indexOf('async function applyGoogleContactFallback');
    const fallbackEnd = source.indexOf('function mergeRecentActivityEvidence', fallbackStart);
    const fallback = source.slice(fallbackStart, fallbackEnd);

    assert.match(fallback, /result\.status === 'error'/);
    assert.match(fallback, /result\.auth_blocked_target === true/);
    assert.match(fallback, /if \(terminalRow\)/);
    assert.match(fallback, /return;/);
});

test('every row pushes exactly one dataset item carrying its join keys', async () => {
    const source = await readMain();
    const loopStart = source.indexOf('async function processRequest');
    const loop = source.slice(loopStart, source.indexOf('const batchStartedAt'));

    assert.match(loop, /requestKey: request\.requestKey/);
    assert.match(loop, /inputUrl: url/);
    assert.match(loop, /catch \(rowError\)/);
    assert.match(loop, /result\.status = 'error'/);
    assert.match(loop, /await pushRowInInputOrder\(index, output\)/);
});

test('contract output exposes only attributed nested activity evidence', async () => {
    const source = await readMain();
    const outputStart = source.indexOf('function toCardDataOutput');
    const outputEnd = source.indexOf('/** =================== Per-lead pipeline', outputStart);
    const output = source.slice(outputStart, outputEnd);

    assert.match(output, /recentPosts:\s*qualifyingPosts/);
    assert.match(output, /delete output\.previousPosts/);
    assert.match(output, /return output/);
});

test('login walls and blocks stay distinct contract flags', async () => {
    const source = await readMain();
    const outputStart = source.indexOf('function toCardDataOutput');
    const outputEnd = source.indexOf('/** =================== Per-lead pipeline', outputStart);
    const output = source.slice(outputStart, outputEnd);
    const processStart = source.indexOf('async function processRequest');
    const processEnd = source.indexOf('const batchStartedAt', processStart);
    const process = source.slice(processStart, processEnd);

    assert.match(output, /const loginRequired = Boolean/);
    assert.match(output, /loginRequired,/);
    assert.doesNotMatch(output, /loginRequired:\s*blocked/);
    assert.match(output, /const notFound = \/not found\|unavailable\|doesn't exist\/i\.test\(errorText\)/);
    assert.doesNotMatch(process, /unavailable[\s\S]{0,80}login_required|login_required[\s\S]{0,80}unavailable/i);
});

test('the Actor carries no browser, OCR, or cookie machinery', async () => {
    const source = await readMain();
    const manifest = JSON.parse(await readFile(packageUrl, 'utf8'));

    assert.equal(manifest.dependencies.puppeteer, undefined);
    assert.equal(manifest.dependencies['tesseract.js'], undefined);
    assert.doesNotMatch(source, /puppeteer|tesseract|createWorker|\bpage\.evaluate\b|setCookies/);
});

test('rows run concurrently through a bounded pool and each tags its own log lines', async () => {
    const source = await readMain();

    assert.match(source, /async function mapWithConcurrency\(items, limit, worker\)/);
    assert.match(source, /await mapWithConcurrency\(requests, maxConcurrency, processRequest\)/);
    assert.match(source, /const maxConcurrency = Math\.max\(1, Math\.min\(20, Number\(input\.maxConcurrency \|\| 5\)\)\)/);
    // Interleaved rows are unreadable without a per-row tag, so the row logger is threaded into
    // the helpers rather than each of them writing to console directly.
    assert.match(source, /const log = \(\.\.\.parts\) => console\.log\(`\[\$\{request\.requestKey\}\]`, \.\.\.parts\)/);
    assert.match(source, /readCotProof\(url, \{[\s\S]*?log,/);
    assert.match(source, /applyGoogleContactFallback\(result, scopedInput, log\)/);
});

test('exit countries are chosen for speed and rotate per row and per retry', async () => {
    const source = await readMain();

    assert.match(source, /const FAST_PROXY_COUNTRIES = \['GB', 'US', 'DE', 'NL', 'FR'\]/);
    assert.match(source, /FAST_PROXY_COUNTRIES\[\(rowIndex \+ attempt\) % FAST_PROXY_COUNTRIES\.length\]/);
    // The input field stays declared so existing callers validate, but nothing reads its value.
    assert.doesNotMatch(source, /input\.facebookProxyCountry/);
});

test('rows finish out of order but reach the dataset in input order', async () => {
    const source = await readMain();

    assert.match(source, /function pushRowInInputOrder\(index, output\)/);
    assert.match(source, /while \(finishedRows\.has\(nextRowToPush\)\)/);
    // A resumed row must release its slot without re-pushing, or every later row is held forever.
    assert.match(source, /await pushRowInInputOrder\(index, null\)/);
    // Exactly one place writes to the dataset, and it is the ordered queue.
    assert.equal(source.match(/Actor\.pushData\(/g).length, 1);
});

test('Google fallback uses explicit contact requirements after terminal-row checks', async () => {
    const source = await readMain();
    const fallbackStart = source.indexOf('async function applyGoogleContactFallback');
    const fallback = source.slice(fallbackStart, source.indexOf('function mergeRecentActivityEvidence', fallbackStart));

    assert.ok(fallback.indexOf('if (terminalRow)') < fallback.indexOf('googleContactRequest(result, input)'));
    assert.match(fallback, /if \(!requested\) return/);
});

test('a name-only search with no candidate host does not pay for the follow-up query', async () => {
    const source = await readMain();

    assert.match(source, /if \(queryIndex === 0 && !uniqueCandidates\.length\) \{/);
});
