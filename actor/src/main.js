import { normalizeGoogleEvidence, googleBusinessIdentityMatches, isAllowedGoogleContactUrl, readOfficialContacts, readStructuredAddresses, googleContactRequest, mergeGoogleContact } from './googleContacts.js';
import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { toCotProofOutput } from './cotProof.js';
import { readCotProof } from './cotReader.js';

import { canonicalizeAcceptedActivityObservations, describeActivityStory } from './activityScanPolicy.js';
import { buildActorRequests } from './batchRequests.js';
import { completedBatchRequestKeys } from './batchResume.js';
import { createProxySessionId } from './browserProxy.js';
import { classifyChainSignals } from './chainSignals.js';
import { extractPageEvidence } from './facebookPageEvidence.js';
import { TIMELINE_TIME_SOURCE } from './facebookTimelineFeed.js';
import { fetchGoogleSerp } from './googleSerp.js';
import { htmlToVisibleText, readHtmlAnchors, readHtmlTitle } from './htmlText.js';

function derivePageUrlFromPostUrl(postUrl) {
  try {
    const u = new URL(postUrl);

    // Case 1: Pretty username posts
    const m1 = u.pathname.match(/^\/([^/]+)\/posts\//);
    if (m1) return `https://www.facebook.com/${m1[1]}`;

    // Case 2: profile.php?id=...
    if (u.pathname.includes('/profile.php') && u.searchParams.get('id')) {
      return `https://www.facebook.com/profile.php?id=${u.searchParams.get('id')}`;
    }

    // Case 3: Watch or Reel ? cannot derive directly
    if (u.pathname.startsWith('/watch') || u.pathname.startsWith('/reel')) {
      return null;  // must be resolved from DOM
    }

    // Fallback: strip query params
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function canonicalizeFacebookUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl, 'https://www.facebook.com');
    u.hostname = u.hostname.toLowerCase().replace(/^m\./, 'www.').replace(/^web\./, 'www.');
    [
      '__cft__[0]', '__tn__', '_cft_', '_tn_', 'comment_id', 'reply_comment_id',
      'mibextid', 'ref', 'refsrc', 'idorcid'
    ].forEach((key) => u.searchParams.delete(key));
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return String(rawUrl).trim();
  }
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** =================== Google official-site contact fallback =================== */
function googleFallbackRemainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function googleFallbackBudgetError() {
  const error = new Error('Google fallback time budget exhausted');
  error.code = 'GOOGLE_FALLBACK_BUDGET';
  return error;
}

/**
 * Fetch one candidate official site and reduce it to the evidence the identity check needs.
 *
 * The time budget is enforced as a request timeout rather than a navigation timeout: an official
 * site that keeps loading analytics long after its useful HTML arrived should not cost the row its
 * remaining budget, and an HTTP read is finished as soon as the body is in hand.
 */
async function readGoogleContactCandidate(url, deadline) {
  const remainingBeforeRequest = googleFallbackRemainingMs(deadline);
  if (remainingBeforeRequest < 500) throw googleFallbackBudgetError();

  const response = await gotScraping({
    url,
    followRedirect: true,
    throwHttpErrors: false,
    timeout: { request: Math.max(500, Math.min(5500, remainingBeforeRequest - 200)) },
  });

  if (googleFallbackRemainingMs(deadline) < 150) throw googleFallbackBudgetError();
  const html = String(response.body || '');
  const finalUrl = response.url || url;
  const anchors = readHtmlAnchors(html, finalUrl);
  const hostname = (() => {
    try {
      return new URL(finalUrl).hostname;
    } catch {
      return '';
    }
  })();

  return {
    text: htmlToVisibleText(html).slice(0, 200000),
    structuredAddresses: readStructuredAddresses(html),
    title: readHtmlTitle(html),
    url: finalUrl,
    mailto: anchors.find((anchor) => /^mailto:/i.test(anchor.href))?.href || '',
    tel: anchors.find((anchor) => /^tel:/i.test(anchor.href))?.href || '',
    contactUrl:
      anchors.find((anchor) => {
        if (!/\b(contact|contact us|get in touch)\b/i.test(anchor.text)) return false;
        try {
          return new URL(anchor.href).hostname === hostname;
        } catch {
          return false;
        }
      })?.href || '',
  };
}

async function getGoogleContactInfo(lead = {}, requested = {}, options = {}) {
  const log = options.log || console.log;
  const businessName = String(lead.name || lead.Name || '').trim();
  if (!businessName) return {};

  const budgetMs = Math.max(5000, Math.min(30000, Number(options.budgetMs || 15000)));
  const deadline = Date.now() + budgetMs;
  const rawPostcode = String(lead.zip || lead.ZIP || lead.postcode || '').trim();
  const normalizedAddress = normalizeGoogleEvidence(lead.address || lead.Address);
  const ignoredLocationTokens = new Set([
    'united', 'kingdom', 'england', 'scotland', 'wales', 'street', 'road', 'lane',
    'high', 'gardens', 'garden', 'avenue', 'close', 'drive', 'park', 'industrial', 'estate'
  ]);
  const locationTokens = normalizedAddress
    .split(' ')
    .filter((token) => token.length >= 4 && !ignoredLocationTokens.has(token));
  const locationHint = locationTokens.at(-1) || rawPostcode;
  const country = normalizeGoogleEvidence(lead.country || lead.Country);
  const domainFilter = /(^| )(united kingdom|uk|england|scotland|wales)( |$)/.test(country)
    ? ' site:co.uk'
    : '';

  // Name-only first is normally the fastest way to discover the official domain. Location is then
  // verified against the site itself before any contact is accepted. The location-qualified query
  // remains as a second chance for common business names, but only when time remains.
  const searchQueries = [...new Set([
    `"${  businessName  }"${  domainFilter}`,
    `"${  businessName  }"${  locationHint ? ` ${  locationHint}` : ''  }${domainFilter}`
  ])];

  try {
    const proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['GOOGLE_SERP'] });
    const proxyUrl = await proxyConfiguration.newUrl();

    // Sequential on purpose, and measured rather than assumed.
    //
    // Overlapping the two searches looks like free latency and is not: sharing one proxy session
    // made each 300 KB+ SERP take 15s instead of 6s, and giving each its own exit IP still cost
    // 9.8s against 6.2s sequential. Google serves one search from one IP faster than two at once,
    // and the first query settling the answer skips the second entirely.
    for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex++) {
      const activeQuery = searchQueries[queryIndex];
      const remainingBeforeSearch = googleFallbackRemainingMs(deadline);
      if (remainingBeforeSearch < (queryIndex === 0 ? 6000 : 12000)) break;

      const serp = await fetchGoogleSerp(activeQuery, {
        proxyUrl,
        remainingMs: remainingBeforeSearch,
        log,
      });
      if (serp.failureReason) {
        log('Google SERP query skipped:', serp.failureReason);
        continue;
      }
      if (googleFallbackRemainingMs(deadline) < 500) break;

      // Google wraps most result links in its own /url redirector, so the destination has to be
      // unwrapped from the query string before any of it can be identity-matched.
      const candidates = readHtmlAnchors(serp.html, 'http://www.google.com')
        .map(({ href }) => {
          try {
            const url = new URL(href);
            if (url.hostname.includes('google.') && (url.pathname === '/url' || url.pathname === '/imgres')) {
              return url.searchParams.get('q') || url.searchParams.get('url') || url.searchParams.get('imgurl') || '';
            }
            return url.href;
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      const businessTokens = normalizeGoogleEvidence(businessName)
        .split(' ')
        .filter((token) => token.length > 2 && !['and', 'the', 'ltd', 'limited', 'company'].includes(token));
      const minimumDomainMatches = Math.max(1, Math.ceil(businessTokens.length * 0.6));

      // Google often returns five pages from the same official domain (home/menu/about/gallery/etc.).
      // The old loop visited all of them. Collapse every host to its homepage, then follow at most
      // one on-site Contact link. That preserves identity checks while bounding network work.
      const candidatesByHost = new Map();
      for (const rawUrl of [...new Set(candidates)].filter(isAllowedGoogleContactUrl)) {
        try {
          const parsed = new URL(rawUrl);
          const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
          const domainMatches = businessTokens.filter((token) => host.includes(token)).length;
          if (domainMatches < minimumDomainMatches) continue;
          const existing = candidatesByHost.get(host);
          const candidate = { url: `${parsed.origin  }/`, domainMatches };
          if (!existing || candidate.domainMatches > existing.domainMatches) {
            candidatesByHost.set(host, candidate);
          }
        } catch {}
      }
      const uniqueCandidates = [...candidatesByHost.values()]
        .sort((a, b) => b.domainMatches - a.domainMatches)
        .slice(0, 2)
        .map((candidate) => candidate.url);

      log('Google search diagnostics:', {
        provider: 'GOOGLE_SERP proxy',
        queryType: queryIndex === 0 ? 'name-only' : 'name-and-location',
        serpBytes: serp.html.length,
        anchorCount: candidates.length,
        candidateCount: uniqueCandidates.length,
        budgetRemainingMs: googleFallbackRemainingMs(deadline)
      });
      // Zero candidates has two very different causes - the business genuinely has no official
      // site, or the results never reached the domain filter (a consent page, a block page, a
      // markup change). Naming the hosts that were actually seen is what tells them apart.
      if (!uniqueCandidates.length) {
        const seenHosts = [...new Set(candidates.map((candidateUrl) => {
          try { return new URL(candidateUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
        }).filter(Boolean))];
        log('   no identity-matched candidate; hosts seen:', seenHosts.slice(0, 8).join(', ') || '(none)');
      }

      // At most two hosts survive the domain filter and neither depends on the other, so they are
      // read together; the identity checks below still run in ranked order.
      const candidatePages = await Promise.all(
        uniqueCandidates.map((candidateUrl) =>
          googleFallbackRemainingMs(deadline) < 700
            ? Promise.resolve({ candidateUrl, error: googleFallbackBudgetError() })
            : readGoogleContactCandidate(candidateUrl, deadline).then(
                (candidate) => ({ candidateUrl, candidate }),
                (error) => ({ candidateUrl, error }),
              ),
        ),
      );

      for (const { candidateUrl, candidate, error: candidateFetchError } of candidatePages) {
        try {
          if (candidateFetchError) throw candidateFetchError;
          const homepageIdentity = googleBusinessIdentityMatches(
            [candidate.title, candidate.text].join('\n'),
            candidate.url,
            lead
          );
          log('Google official-site candidate:', {
            requestedUrl: candidateUrl,
            finalUrl: candidate.url,
            title: String(candidate.title || '').slice(0, 100),
            nameScore: homepageIdentity.nameScore,
            locationMatched: homepageIdentity.locationMatched,
            postcodeMatched: homepageIdentity.postcodeMatched,
            identityMatched: homepageIdentity.matched,
            hasContactLink: Boolean(candidate.contactUrl),
            budgetRemainingMs: googleFallbackRemainingMs(deadline)
          });
          const contact = await readOfficialContacts(candidate, lead, requested, {
            readCandidate: url => readGoogleContactCandidate(url, deadline),
            canRead: () => googleFallbackRemainingMs(deadline) >= 700,
          });
          if (contact) return { ...contact, googleSearchQuery: activeQuery };
        } catch (candidateError) {
          if (candidateError?.code === 'GOOGLE_FALLBACK_BUDGET') break;
          log('Google contact candidate skipped:', candidateError.message);
        }
      }

      // When the broad name-only search surfaces no candidate host, the narrower location-qualified
      // one is paying another SERP to look at a different slice of the same absent website. It buys
      // some recall - the two queries do return different results - but not enough to be the
      // default when it doubles the row's search cost.
      if (queryIndex === 0 && !uniqueCandidates.length) {
        log('No candidate host from the name-only search; skipping the location-qualified follow-up');
        break;
      }
      if (googleFallbackRemainingMs(deadline) < 5000) break;
    }

    const timedOut = googleFallbackRemainingMs(deadline) < 500;
    return {
      googleSearchQuery: searchQueries.join(' || '),
      googleContactWarning: timedOut
        ? `Google fallback stopped at ${budgetMs}ms budget`
        : 'No identity-matched official website contact was found'
    };
  } catch (error) {
    log('Google search failed safely:', error.message);
    return {
      googleSearchQuery: searchQueries.join(' || '),
      googleContactWarning: error?.code === 'GOOGLE_FALLBACK_BUDGET'
        ? `Google fallback stopped at ${budgetMs}ms budget`
        : `Google search failed safely: ${  error.message}`
    };
  }
}

async function applyGoogleContactFallback(result, input, log = console.log) {
  const terminalErrorText = String(result.error || result.contactError || '');
  const terminalRow =
    result.status === 'error' ||
    result.auth_blocked === true ||
    result.auth_blocked_target === true ||
    /checkpoint|login wall|login required|temporarily blocked/i.test(terminalErrorText);
  if (terminalRow) {
    log('Skipping Google fallback for an auth-blocked/error row');
    return;
  }
  const requested = googleContactRequest(result, input);
  if (!requested) return;
  log('Searching Google for missing official business contacts...');
  const googleContact = await getGoogleContactInfo(
    input.lead || {},
    requested,
    { budgetMs: input.googleFallbackBudgetMs || 45000, log }
  );
  mergeGoogleContact(result, googleContact);
}

function mergeRecentActivityEvidence(postCollections, maxResults) {
  const observations = postCollections
    .flat()
    .filter(Boolean)
    .map((post) => ({
      ...post,
      postUrl: canonicalizeFacebookUrl(post?.postUrl || ''),
    }));
  return canonicalizeAcceptedActivityObservations(observations, {
    canonicalizeUrl: canonicalizeFacebookUrl,
    maxResults,
  }).posts;
}

/**
 * Facebook's own server epoch for the post, read from the logged-out timeline query.
 *
 * The rendered-text sources this set used to carry - `feed-aria`, `dom-aria-story` and the rest -
 * were dates inferred from strings like "22 hours ago" and then paired with an author by walking
 * the DOM. Nothing produces them any more, and leaving them listed would mean an observation
 * labelled with one still counted as trusted evidence.
 */
const TRUSTED_ACTIVITY_SOURCES = new Set([TIMELINE_TIME_SOURCE]);

const ACTIVITY_DAY_MS = 24 * 60 * 60 * 1000;

function isActivityPostPermalink(value) {
  const url = canonicalizeFacebookUrl(value || '');
  return Boolean(
    url &&
      describeActivityStory({ postUrl: url }, canonicalizeFacebookUrl).strongKey,
  );
}

function activityAuthorMatches(author, pageName) {
  if (!author || !pageName) return false;
  const normalize = (value) =>
    String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const actual = normalize(author);
  const expected = normalize(pageName);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const stopWords = new Set(['the', 'and', 'of', 'at', 'by', 'co', 'company', 'official', 'page']);
  const meaningfulTokens = (value) =>
    value
      .split(/\s+/)
      .filter(
        (token) =>
          token &&
          !stopWords.has(token) &&
          !['ltd', 'limited', 'uk'].includes(token),
      );
  const actualTokens = meaningfulTokens(actual);
  const expectedTokens = meaningfulTokens(expected);
  if (!actualTokens.length || actualTokens.length !== expectedTokens.length) return false;
  const actualTokenSet = new Set(actualTokens);
  return expectedTokens.every((token) => actualTokenSet.has(token));
}

function activityEvidenceReason(
  post,
  pageName,
  { now = new Date(), pageIdentityMatched = false } = {},
) {
  const source = String(post?.time_source || '').trim().toLowerCase();
  const author = String(post?.author || '').trim();
  const authorMatches = activityAuthorMatches(post?.author, pageName);
  const storyAuthorMatched = Boolean(author && pageName && authorMatches);
  const verifiedStoryCard =
    post?.storyScoped === true &&
    /^feed-(?:time|epoch|aria)$/.test(source) &&
    Boolean(author) &&
    Boolean(String(pageName || '').trim()) &&
    Boolean(String(post?.postText || '').trim()) &&
    authorMatches;
  if (!TRUSTED_ACTIVITY_SOURCES.has(source)) return 'untrusted-timestamp-source';
  if (!isActivityPostPermalink(post?.postUrl) && !verifiedStoryCard) {
    return 'missing-post-permalink';
  }
  const date = post?.posted_at_iso ? new Date(post.posted_at_iso) : null;
  if (!date || Number.isNaN(date.getTime())) return 'invalid-post-date';
  if (date.getTime() > now.getTime()) return 'future-post-date';
  if (author && pageName && !authorMatches) return 'post-author-mismatch';
  if (!pageIdentityMatched && !storyAuthorMatched) return 'unattributed-activity';
  return null;
}

function normalizeActivityPosts(result) {
  const targetPost = {
    postUrl: canonicalizeFacebookUrl(result.postUrl || result.inputUrl || ''),
    posted_at_raw: result.posted_at_raw || result.postDate || null,
    posted_at_iso: safeIso(result.posted_at_iso),
    time_source: result.time_source || null,
    postDate: result.postDate || result.posted_at_raw || null,
    postText: result.postText || null,
    author: result.postAuthor || null,
    storyScoped: /-story$/i.test(String(result.time_source || '')),
    status: result.status || 'success',
  };

  const observations = [targetPost, ...(Array.isArray(result.previousPosts) ? result.previousPosts : [])]
    .map((post) => ({
      ...post,
      postUrl: canonicalizeFacebookUrl(post.postUrl || ''),
      posted_at_iso: safeIso(post.posted_at_iso),
    }))
    // A bare-page target is a synthetic placeholder, not an activity observation. Dated or
    // raw-timestamp candidates remain in scope so an invalid/rejected target fails closed instead
    // of disappearing while older feed evidence drives an inactive verdict.
    .filter(
      (post) =>
        post.postUrl &&
        (post.posted_at_iso || post.posted_at_raw || post.postDate),
    );
  return canonicalizeAcceptedActivityObservations(observations, {
    canonicalizeUrl: canonicalizeFacebookUrl,
  });
}

function evaluateActivityEvidence(result, input, activityWindowDays, now = new Date()) {
  const lead = input.lead || {};
  const normalizedActivity = normalizeActivityPosts(result);
  const recentPosts = normalizedActivity.posts;
  const pageIdentityMatched =
    result.identityStatus === 'matched' && Boolean(String(result.pageName || '').trim());
  const activityPageName = String(
    pageIdentityMatched ? result.pageName : lead.name || lead.Name || '',
  ).trim();
  const evaluatedPosts = recentPosts.map((post) => ({
    ...post,
    reason: activityEvidenceReason(post, activityPageName, {
      now,
      pageIdentityMatched,
    }),
  }));
  const qualifyingPosts = evaluatedPosts
    .filter((post) => !post.reason)
    .map(({ reason: _reason, ...post }) => post);
  const rejectedActivityEvidence = evaluatedPosts.filter((post) => post.reason);
  const datedPosts = qualifyingPosts
    .filter((post) => post.posted_at_iso)
    .sort((left, right) => new Date(right.posted_at_iso) - new Date(left.posted_at_iso));
  const latest = datedPosts[0] || null;
  const latestDate = latest?.posted_at_iso || null;
  const latestMs = latestDate ? Date.parse(latestDate) : NaN;
  const ageMs = Number.isFinite(latestMs) ? now.getTime() - latestMs : null;
  const activityWindowMs = activityWindowDays * ACTIVITY_DAY_MS;
  const matchedStory = qualifyingPosts.find(
    (post) =>
      String(post.author || '').trim() &&
      activityAuthorMatches(post.author, activityPageName),
  );
  let attribution = { status: 'unverified', name: activityPageName };
  if (pageIdentityMatched) {
    attribution = {
      status: 'page-identity-matched',
      name: String(result.pageName || ''),
    };
  } else if (matchedStory) {
    attribution = {
      status: 'story-author-matched',
      name: String(matchedStory.author || ''),
    };
  }
  const canonicalizationWarning = normalizedActivity.conflicts.length
    ? `activity-canonicalization-conflict:${normalizedActivity.conflicts
        .map((conflict) => conflict.reason)
        .join(',')}`
    : null;
  const warning = result.activityWarning
    ? String(result.activityWarning)
    : canonicalizationWarning;
  const scan = {
    attempted: result.activityScanAttempted === true,
    complete:
      result.activityScanComplete === true &&
      !warning &&
      rejectedActivityEvidence.length === 0,
    warning,
    stoppingReason: result.activityScanStoppingReason || null,
    passes: Array.isArray(result.activityScanPasses) ? result.activityScanPasses : [],
    trustedCount: qualifyingPosts.length,
    rejectedCount: rejectedActivityEvidence.length,
    conflictCount: normalizedActivity.conflicts.length,
  };

  return {
    recentPosts,
    qualifyingPosts,
    rejectedActivityEvidence,
    latest,
    latestDate,
    ageMs,
    activityWindowMs,
    postedWithinWindow:
      ageMs !== null && ageMs >= 0 && ageMs <= activityWindowMs,
    daysSinceLatestPost:
      ageMs !== null && ageMs >= 0 ? Math.floor(ageMs / ACTIVITY_DAY_MS) : null,
    attribution,
    scan,
  };
}

/**
 * Do we already KNOW this lead falls outside the activity window?
 *
 * The shortcut is intentionally stricter than merely finding an old date: the feed scan must have
 * completed and the date must pass the exact same source, permalink and attribution policy emitted
 * in the final payload. The boundary is compared in milliseconds so 183 days plus one hour cannot
 * be rounded down and reported as inside a 183-day window.
 */
function isDefinitelyOutsideActivityWindow(result, input, activityWindowDays) {
  const now = result.activityDecisionAt
    ? new Date(result.activityDecisionAt)
    : new Date();
  const activity = evaluateActivityEvidence(result, input, activityWindowDays, now);
  return (
    activity.scan.complete &&
    activity.attribution.status !== 'unverified' &&
    activity.ageMs !== null &&
    activity.ageMs > activity.activityWindowMs
  );
}

function toCardDataOutput(result, input, activityWindowDays) {
  const lead = input.lead || {};
  const activityNow = result.activityDecisionAt
    ? new Date(result.activityDecisionAt)
    : new Date();
  const activityAssessment = evaluateActivityEvidence(
    result,
    input,
    activityWindowDays,
    activityNow,
  );
  const {
    recentPosts,
    qualifyingPosts,
    rejectedActivityEvidence,
    latest,
    latestDate,
    daysSinceLatestPost,
  } = activityAssessment;
  const pageUrl = canonicalizeFacebookUrl(result.pageUrl || result.canonicalUrl || derivePageUrlFromPostUrl(result.postUrl) || '');
  const chainSignals = Array.isArray(result.chainSignals) ? result.chainSignals : [];
  const errorText = String(result.error || result.contactError || '');
  const loginRequired = Boolean(
    result.login_required === true ||
      result.login_required_target === true ||
      /checkpoint|login wall|login required/i.test(errorText),
  );
  const blocked = Boolean(
    result.auth_blocked ||
      result.auth_blocked_target ||
      loginRequired ||
      /blocked|misusing this feature|going too fast/i.test(errorText),
  );
  const notFound = /not found|unavailable|doesn't exist/i.test(errorText);
  const success = result.status === 'success' && !blocked && !notFound;
  const { isFranchise: explicitFranchise, isChain: explicitLarge } =
    classifyChainSignals(chainSignals);
  const identityStatus = result.identityStatus || (result.pageName ? 'unconfirmed' : 'missing');
  const identityMatched = identityStatus === 'matched';
  const googleContactIdentityMatched =
    result.contactSource === 'google-official-website' &&
    result.contactIdentityStatus === 'matched' &&
    /^https?:\/\//i.test(String(result.contactSourceUrl || ''));
  const contactIdentityMatched = identityMatched || googleContactIdentityMatched;
  const verifiedActorEmail = contactIdentityMatched && result.emailVerified ? result.email : null;
  const verifiedEmail = verifiedActorEmail || lead.email || null;
  const emailSource = verifiedActorEmail
    ? result.emailSource
    : verifiedEmail
      ? 'submitted-lead'
      : null;
  const actorPhoneVerified = identityMatched || (googleContactIdentityMatched && result.phoneVerified);
  const verifiedPhone = lead.phone || (actorPhoneVerified ? result.phone : null);
  const verifiedWebsite = contactIdentityMatched ? result.website : null;
  const verifiedOwnerName = lead.ownerName || (identityMatched ? result.ownerName : null);
  const pageContactUrl = pageUrl ? `${pageUrl + (pageUrl.includes('?') ? '&' : '?')  }sk=about_contact_and_basic_info` : null;
  const facebookEvidenceUrl =
    identityMatched && /^https?:\/\//i.test(String(result.contactSourceUrl || ''))
      ? result.contactSourceUrl
      : pageContactUrl;

  const output = {
    ...result,
    schemaVersion: 'card-data-v1',
    contractVersion: 'card-data-batch-v1',
    source: 'facebook',
    // result.inputUrl is stamped per iteration; the startUrls[0] fallback below is only correct
    // for single-URL runs, so it must never be what a batched caller relies on.
    inputUrl: result.inputUrl || result.postUrl || input.startUrls?.[0]?.url || input.url || '',
    canonicalUrl: pageUrl,
    pageId: result.pageId || null,
    pageName: result.pageName || null,
    pageNameSource: result.pageNameSource || null,
    email: verifiedEmail,
    emailVerified: Boolean(verifiedEmail),
    emailSource,
    category: result.category || lead.category || null,
    about: result.about || null,
    address: {
      full: typeof result.address === 'string' ? result.address : (result.address?.full || lead.address || null),
      country: result.address?.country || lead.country || null,
      postcode: result.address?.postcode || lead.zip || null
    },
    contact: {
      phone: verifiedPhone,
      phoneVerified: Boolean(verifiedPhone),
      phoneSource: lead.phone ? 'submitted-lead' : (verifiedPhone ? result.phoneSource || 'facebook-page-contact' : null),
      email: verifiedEmail,
      emailVerified: Boolean(verifiedEmail),
      emailSource,
      website: verifiedWebsite,
      ownerName: verifiedOwnerName,
      source: googleContactIdentityMatched
        ? 'google-official-website'
        : lead.phone || lead.email
          ? 'submitted-lead'
          : result.contactSource || (identityMatched ? 'facebook-page' : null),
      sourceUrl: result.contactSourceUrl || (identityMatched ? pageContactUrl : null),
      identityStatus: googleContactIdentityMatched ? 'matched' : identityStatus,
      identityConfidence: googleContactIdentityMatched
        ? result.contactIdentityConfidence || 'high'
        : identityMatched
          ? 'high'
          : 'low',
      searchQuery: result.googleSearchQuery || null
    },
    activity: {
      latestPostDate: latestDate,
      latestPostUrl: latest?.postUrl || null,
      latestPostText: latest?.postText || null,
      daysSinceLatestPost,
      postedWithinWindow: activityAssessment.postedWithinWindow,
      activityWindowDays,
      postsChecked: recentPosts.length,
      trustedPostsChecked: qualifyingPosts.length,
      recentPosts: qualifyingPosts,
      rejectedActivityEvidence,
      attribution: activityAssessment.attribution,
      scan: activityAssessment.scan,
    },
    business: {
      tradingStatus: result.tradingStatus || 'unknown',
      businessSize: explicitLarge ? 'large' : 'unknown',
      isChain: explicitLarge,
      isFranchise: explicitFranchise,
      isLargeBusiness: explicitLarge,
      chainSignals,
      identityStatus,
      identityConfidence: identityMatched ? 'high' : 'low',
      pageNameSource: result.pageNameSource || null,
      wrongBusiness: false
    },
    evidence: {
      activityUrls: qualifyingPosts.map((post) => post.postUrl).filter(Boolean),
      contactSourceUrls: [
        facebookEvidenceUrl && identityMatched && (verifiedPhone || verifiedActorEmail || verifiedWebsite)
          ? facebookEvidenceUrl
          : null,
        googleContactIdentityMatched ? result.contactSourceUrl : null
      ].filter((value, index, all) => value && all.indexOf(value) === index),
      emailSourceUrls: [
        facebookEvidenceUrl && identityMatched && verifiedActorEmail ? facebookEvidenceUrl : null,
        googleContactIdentityMatched && verifiedActorEmail ? result.contactSourceUrl : null
      ].filter((value, index, all) => value && all.indexOf(value) === index),
      facebookOcrIdentityEvidence: result.ocrIdentityEvidence || null,
      googleSearchQuery: result.googleSearchQuery || null,
      googleIdentityEvidence: result.googleIdentityEvidence || null
    },
    scrape: {
      success,
      partial: success && (!latestDate || !result.pageName),
      blocked,
      loginRequired,
      notFound,
      scrapedAt: new Date().toISOString(),
      warnings: [errorText, result.pageUrlError, result.contactError, result.googleContactWarning].filter(Boolean)
    }
  };
  // `previousPosts` is the raw extraction buffer. Only the attributed, trusted subset under
  // `activity.recentPosts` is part of the batch contract.
  delete output.previousPosts;
  return output;
}

/** =================== Per-lead pipeline =================== */

/**
 * Facebook's page name carries its location ("Acme Salon | Glasgow"), and a lead's name rarely
 * does. Matching on the name alone is what the activity attribution already does, so identity
 * uses the same comparison rather than a second, subtly different one.
 */
function resolvePageIdentity(pageName, lead) {
  const expected = String(lead?.name || lead?.Name || '').trim();
  if (!pageName) return { identityStatus: 'missing', identityConfidence: 'low', pageNameSource: null };
  if (expected && activityAuthorMatches(pageName, expected)) {
    return {
      identityStatus: 'matched',
      identityConfidence: 'high',
      pageNameSource: 'facebook-og-title',
    };
  }
  return {
    identityStatus: 'unconfirmed',
    identityConfidence: 'low',
    pageNameSource: 'facebook-og-title',
  };
}

/**
 * Contact evidence is only attributed to the lead once the page itself is. An unconfirmed page can
 * still be the right business, but publishing its phone number against this lead would be a guess,
 * and a wrong contact is worse than a blank one.
 */
function applyPageEvidence(result, evidence, lead) {
  const identity = resolvePageIdentity(evidence.pageName, lead);
  Object.assign(result, identity);
  result.pageName = evidence.pageName || null;
  result.postAuthor = evidence.pageName || null;
  result.category = evidence.category || null;
  result.about = evidence.about || null;
  result.chainSignals = evidence.chainSignals;
  result.tradingStatus = evidence.tradingStatus;

  const attributed = identity.identityStatus === 'matched';
  result.phone = attributed ? evidence.phone : '';
  result.phoneVerified = attributed && Boolean(evidence.phone);
  result.phoneSource = attributed && evidence.phone ? 'facebook-page-page-text' : null;
  result.email = attributed ? evidence.email : '';
  result.emailVerified = attributed && Boolean(evidence.email);
  result.emailSource = attributed && evidence.email ? 'facebook-page-page-text' : null;
  result.website = attributed ? evidence.website : '';
  result.address = attributed ? evidence.address : '';
  result.ownerName = '';
}

/**
 * When the caller passed a permalink rather than a page URL, report that post as the row's target.
 * These are legacy Card-data compatibility fields. The final COT adapter makes
 * the proof decision using exact post identity, including verified document aliases.
 */
function applyTargetPostEvidence(result, posts) {
  const targetKey = describeActivityStory(
    { postUrl: result.inputUrl },
    canonicalizeFacebookUrl,
  ).strongKey;
  if (!targetKey) return;

  const match = posts.find(
    (post) => describeActivityStory(post, canonicalizeFacebookUrl).strongKey === targetKey,
  );
  if (!match) return;

  result.posted_at_raw = match.posted_at_raw;
  result.posted_at_iso = match.posted_at_iso;
  result.time_source = match.time_source;
  result.postDate = match.postDate;
  result.postText = match.postText;
}

await Actor.init();
console.log('Actor initialized (HTTP-only, logged out)');

const input = (await Actor.getInput()) || {};
const requests = buildActorRequests(input);
const defaultDataset = await Actor.openDataset();
const existingDataset = await defaultDataset.getData({ fields: ['requestKey', 'inputUrl'] });
const completedRequestKeys = completedBatchRequestKeys(requests, existingDataset.items || []);
console.log('Input received:', {
  urlCount: requests.length,
  batchMode: Array.isArray(input.requests) && input.requests.length > 0,
  maxPosts: input.maxPosts || 3,
  resumedRows: completedRequestKeys.size,
});

if (!requests.length) throw new Error('No Facebook URLs provided');

const activityWindowDays = Math.max(1, Math.min(730, Number(input.activityWindowDays || 1)));
const maxPosts = Math.max(1, Math.min(20, Number(input.maxPosts || 3)));
const maxAttempts = Math.max(1, Math.min(6, Number(input.maxRequestRetries || 3)));
// Rows are pure network wait, so they overlap freely. The cap is about how many residential
// requests Facebook sees at once, not about local CPU.
const maxConcurrency = Math.max(1, Math.min(20, Number(input.maxConcurrency || 5)));
console.log(
  `Processing ${requests.length} URL(s) at concurrency ${maxConcurrency}; up to ${maxPosts} recent posts inside ${activityWindowDays} days`,
);

/**
 * Every retry draws a fresh exit IP. Facebook serves a contentless shell at random and a different
 * IP is what clears it, so reusing one sticky session across attempts would just re-ask the same
 * machine the same question.
 */
/**
 * Exit countries chosen for latency to Facebook, not for where a lead trades.
 *
 * A Facebook business page renders the same wherever it is read from, so the exit country buys
 * nothing but round-trip time - and it costs plenty when it is wrong: the same three UK leads took
 * 49s through PH with one row failing every retry, and 34s through GB with none. The country in
 * the input is therefore ignored in favour of this list.
 *
 * Rows start at different points in the list and each retry advances one, so a retry changes both
 * the exit IP and the country it comes from.
 */
const FAST_PROXY_COUNTRIES = ['GB', 'US', 'DE', 'NL', 'FR'];

let makeProxyDrawer = () => null;
if (input.useResidentialProxy !== false) {
  const proxyConfigurations = new Map();
  for (const country of FAST_PROXY_COUNTRIES) {
    proxyConfigurations.set(
      country,
      await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: country }),
    );
  }
  // Without credentials the SDK returns nothing here rather than throwing, and every row then
  // fails on the first proxy draw. Failing the run outright says what is wrong once, instead of
  // spending the whole batch producing identical unexplained row errors.
  if ([...proxyConfigurations.values()].some((configuration) => !configuration)) {
    throw new Error(
      'Residential proxy was requested but no Apify proxy credentials are available. Set APIFY_TOKEN or APIFY_PROXY_PASSWORD, or run with useResidentialProxy: false.',
    );
  }

  const runId = Actor.getEnv().actorRunId;
  makeProxyDrawer = (rowIndex) => async (attempt) => {
    const country = FAST_PROXY_COUNTRIES[(rowIndex + attempt) % FAST_PROXY_COUNTRIES.length];
    return proxyConfigurations
      .get(country)
      .newUrl(`${createProxySessionId(runId)}_${rowIndex}_${attempt}_${Date.now()}`);
  };
  console.log('Facebook proxy initialized', {
    group: 'RESIDENTIAL',
    countries: FAST_PROXY_COUNTRIES.join(','),
    note: 'facebookProxyCountry is ignored; exit countries are chosen for speed',
  });
}

/**
 * Run `worker` over every item with at most `limit` in flight.
 *
 * Rows share nothing - each opens its own Facebook session on its own proxy draw - so the only
 * reason to run them one at a time was that the browser could not be in two places at once. What
 * bounds throughput now is network latency, and the fix for latency is overlap.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

/**
 * Push finished rows in input order while they still run out of order.
 *
 * Concurrency made the dataset land in completion order: a lead needing a Google search finishes
 * long after one that does not, so it arrived last no matter where it sat in the input. A caller
 * can always join on requestKey, but nothing about running rows in parallel requires handing back
 * a shuffled dataset.
 *
 * A row is held until every earlier row has been pushed, then it and any already-finished rows
 * behind it are released together. Rows still stream out as the batch progresses rather than being
 * buffered to the end, which is what keeps a restart able to resume from what was already saved.
 */
let nextRowToPush = 0;
const finishedRows = new Map();
let pushQueue = Promise.resolve();

function pushRowInInputOrder(index, output) {
  finishedRows.set(index, output);
  // Fully synchronous: the queue is extended here and awaited by the caller, so two rows finishing
  // together cannot interleave their pushes or claim the same position.
  while (finishedRows.has(nextRowToPush)) {
    const item = finishedRows.get(nextRowToPush);
    finishedRows.delete(nextRowToPush);
    nextRowToPush += 1;
    // A resumed row releases its position without pushing anything - it is already in the dataset.
    if (item) pushQueue = pushQueue.then(() => Actor.pushData(item));
  }
  return pushQueue;
}

/**
 * One lead, start to finish. Rows interleave in the log once they run concurrently, so every line
 * a row emits is tagged with its requestKey - otherwise a batch's output is unreadable.
 */
async function processRequest(request, index) {
  const { url } = request;
  const scopedInput = { ...input, lead: request.lead || {} };
  const log = (...parts) => console.log(`[${request.requestKey}]`, ...parts);

  if (completedRequestKeys.has(request.requestKey)) {
    log(`Skipping saved requestKey after Actor restart: ${url}`);
    await pushRowInInputOrder(index, null);
    return;
  }
  log(`Processing ${index + 1}/${requests.length}: ${url}`);

  // requestKey/inputUrl are stable join keys for a batching caller. They must survive redirects,
  // canonicalisation and failures so every dataset item maps back to the exact source row.
  const result = {
    postUrl: url,
    inputUrl: url,
    requestKey: request.requestKey,
    activityScanAttempted: false,
    activityScanComplete: false,
    activityScanStoppingReason: 'not-attempted',
    activityScanPasses: [],
    activityWarning: null,
    previousPosts: [],
    // Present-and-null, never absent: a bare page URL has no target post, and a consumer reading
    // these fields should find them empty rather than missing.
    posted_at_raw: null,
    posted_at_iso: null,
    time_source: 'none',
    postDate: null,
    postText: '',
    // Every stage key is emitted even when a stage does no work, so a caller summing them does not
    // have to know which stages this run happened to take.
    stageTimingsMs: { targetNavigation: 0, activityScan: 0, facebookEnrichment: 0, googleFallback: 0, total: 0 },
    googleSearchQuery: null,
    googleContactWarning: null,
  };
  const rowStartedAt = Date.now();

  try {
    const targetNavigationStartedAt = Date.now();
    const proof = await readCotProof(url, {
      newProxyUrl: makeProxyDrawer(index),
      maxAttempts,
      maxPosts,
      includePreviousPosts: scopedInput.includePreviousPosts,
      log,
    });
    result.stageTimingsMs.targetNavigation = Date.now() - targetNavigationStartedAt;
    result.proofResolution = proof.resolution;
    result.proofPreview = proof.preview;
    result.proofFailureReason = proof.failureReason;
    result.previousPosts = proof.posts;
    result.activityScanAttempted = proof.scanAttempted;
    result.activityScanComplete = proof.posts.length > 0 && !proof.failureReason;
    result.activityScanStoppingReason = proof.failureReason || 'bounded-public-proof-read';
    result.activityWarning = proof.failureReason;
    const session = proof.session;
    if (!session && !proof.posts.length) throw new Error(proof.failureReason || 'proof-document-has-no-dated-story');
    result.pageId = session?.pageId || null;
    result.pageUrl = canonicalizeFacebookUrl(session?.pageUrl || derivePageUrlFromPostUrl(url) || url);
    result.facebookEvidenceUrl = session?.pageUrl || null;

    if (session) applyPageEvidence(result, extractPageEvidence(session.html), scopedInput.lead);
    log('page evidence:', {
      pageName: result.pageName,
      identity: result.identityStatus,
      phone: Boolean(result.phone),
      email: Boolean(result.email),
      website: Boolean(result.website),
    });

    result.activityScanPasses = [{ pass: 'public-proof', complete: result.activityScanComplete,
      stoppingReason: result.activityScanStoppingReason, discoveredCount: proof.posts.length }];
    applyTargetPostEvidence(result, proof.posts);

    result.activityDecisionAt = new Date().toISOString();
    result.status = 'success';
  } catch (rowError) {
    log('failed:', rowError.message);
    result.status = 'error';
    result.error = rowError.message;
    result.activityWarning = result.activityWarning || `row-error: ${rowError.message}`;
  }

  // Contact enrichment is the expensive half of a row and buys nothing for a lead already proven
  // inactive, so the caller can skip it once the activity verdict is settled.
  const skipInactiveEnrichment =
    scopedInput.skipContactEnrichmentWhenInactive !== false &&
    isDefinitelyOutsideActivityWindow(result, scopedInput, activityWindowDays);
  if (skipInactiveEnrichment) {
    log('inactive within the window; skipping Google contact enrichment');
    result.googleContactWarning = 'Google fallback skipped for a lead already proven inactive';
  } else {
    const googleStartedAt = Date.now();
    await applyGoogleContactFallback(result, scopedInput, log);
    result.stageTimingsMs.googleFallback = Date.now() - googleStartedAt;
  }

  result.stageTimingsMs.total = Date.now() - rowStartedAt;
  const output = toCotProofOutput(toCardDataOutput(result, scopedInput, activityWindowDays), result);
  log('complete:', {
    pageName: output.pageName,
    identity: output.business?.identityStatus,
    trustedPosts: output.activity?.trustedPostsChecked,
    latestPostDate: output.activity?.latestPostDate,
    withinWindow: output.activity?.postedWithinWindow,
    ms: result.stageTimingsMs.total,
  });
  await pushRowInInputOrder(index, output);
}

const batchStartedAt = Date.now();
await mapWithConcurrency(requests, maxConcurrency, processRequest);
console.log(
  `\nActor execution completed: ${requests.length} row(s) in ${Math.round((Date.now() - batchStartedAt) / 1000)}s at concurrency ${maxConcurrency}`,
);
await Actor.exit();
