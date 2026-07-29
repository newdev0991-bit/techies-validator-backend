export const AINSLEY_PROFILE = 'ainsley-business-activity';
export const DEFAULT_ACTIVITY_WINDOW_DAYS = 183;

const CLOSED_RE =
  /\b(permanently closed|ceased trading|no longer trading|business closed|closed down|dissolved)\b/i;
const TEMPORARILY_CLOSED_RE = /\btemporarily closed\b/i;
const FRANCHISE_RE = /\b(franchise|franchising|franchisee)\b/i;
const LARGE_BUSINESS_RE =
  /\b(nationwide|national chain|international chain|hundreds of locations|stores nationwide)\b/i;

function firstValue(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return fallback;
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normalizePostcode(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '');
}

export function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('44')) return `+${digits}`;
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;
  return digits ? `+${digits}` : '';
}

export function canonicalizeFacebookUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    url.hostname = url.hostname
      .toLowerCase()
      .replace(/^m\./, 'www.')
      .replace(/^web\./, 'www.');
    const removable = [
      '__cft__[0]',
      '__tn__',
      '_cft_',
      '_tn_',
      'comment_id',
      'reply_comment_id',
      'mibextid',
      'ref',
      'refsrc'
    ];
    removable.forEach((key) => url.searchParams.delete(key));
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return String(value).trim();
  }
}

export function normalizeLead(row = {}) {
  return {
    name: firstValue(row, ['name', 'Name', 'Company Name', 'Company']),
    category: firstValue(row, ['category', 'Category', 'Industry Type', 'Industry']),
    link: firstValue(row, [
      'link',
      'Link',
      'Facebook URL',
      'Facebook Link',
      'Lead Proof URL'
    ]),
    address: firstValue(row, [
      'address',
      'Address',
      'Address 1',
      'Address 1 (Road/Street/Lane/Park/Industrial Estate)'
    ]),
    country: firstValue(row, ['country', 'Country'], 'United Kingdom'),
    zip: firstValue(row, [
      'zip',
      'ZIP',
      'Postcode',
      'Post Code',
      'Post Code (Please Put The Full Postcode, Example: CH41 5LH)'
    ]),
    phone: firstValue(row, ['phone', 'Phone', 'Phone Number']),
    ownerName: firstValue(row, ['ownerName', 'Owner Name']),
    email: firstValue(row, ['email', 'Email']),
    comment: firstValue(row, ['comment', 'Comment']),
    passFail: firstValue(row, ['passFail', 'Pass/Fail'])
  };
}

function safeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizePost(post = {}) {
  const date =
    safeDate(post.posted_at_iso) ||
    safeDate(post.latestPostDate) ||
    safeDate(post.postDate);
  return {
    url: canonicalizeFacebookUrl(post.postUrl || post.url || ''),
    date: date?.toISOString() || null,
    text: String(post.postText || post.text || '').trim() || null,
    source: post.time_source || post.source || null,
    status: post.status || 'success',
    error: post.error || null
  };
}

function uniquePosts(posts) {
  const seen = new Set();
  return posts.filter((post) => {
    const key = post.url || `${post.date}|${post.text || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenSimilarity(left, right) {
  const ignored = new Set([
    'and',
    'the',
    'ltd',
    'limited',
    'uk',
    'services',
    'service',
    'company',
    'co'
  ]);
  const tokens = (value) =>
    new Set(
      normalizeText(value)
        .split(' ')
        .filter((token) => token.length > 1 && !ignored.has(token))
    );
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return null;
  const matches = [...a].filter((token) => b.has(token)).length;
  return matches / Math.min(a.size, b.size);
}

function buildDuplicateKey(lead, actorData) {
  const pageId = String(actorData?.pageId || '').trim();
  if (pageId) return `facebook-page:${pageId}`;

  const canonicalUrl = canonicalizeFacebookUrl(
    actorData?.canonicalUrl || actorData?.pageUrl || lead.link
  );
  if (canonicalUrl) return `facebook-url:${canonicalUrl.toLowerCase()}`;

  const phone = normalizePhone(actorData?.contact?.phone || actorData?.phone || lead.phone);
  if (phone) return `phone:${phone}`;

  const name = normalizeText(lead.name);
  const postcode = normalizePostcode(lead.zip);
  return name && postcode ? `name-postcode:${name}|${postcode}` : '';
}

function inferScrapeState(actorData) {
  const scrape = actorData?.scrape || {};
  const errorText = String(actorData?.error || scrape.error || '');
  const blocked = Boolean(
    scrape.blocked ||
      actorData?.auth_blocked ||
      actorData?.auth_blocked_target ||
      /blocked|checkpoint|login required|login wall/i.test(errorText)
  );
  const notFound = Boolean(scrape.notFound || /not found|unavailable|doesn't exist/i.test(errorText));
  const success =
    scrape.success !== undefined
      ? Boolean(scrape.success)
      : actorData?.status === 'success' && !blocked && !notFound;
  const partial = Boolean(scrape.partial || (!success && !blocked && !notFound));

  return {
    success,
    partial,
    blocked,
    loginRequired: Boolean(scrape.loginRequired || blocked),
    notFound,
    scrapedAt: scrape.scrapedAt || new Date().toISOString(),
    warnings: [
      ...(Array.isArray(scrape.warnings) ? scrape.warnings : []),
      ...(errorText ? [errorText] : [])
    ]
  };
}

export function normalizeActorEvidence(
  actorData = {},
  normalizedLead = {},
  { activityWindowDays = DEFAULT_ACTIVITY_WINDOW_DAYS, now = new Date() } = {}
) {
  const lead = normalizeLead(normalizedLead);
  const structuredPosts = actorData?.activity?.recentPosts || [];
  const legacyPosts = actorData?.previousPosts || [];
  const targetPost = {
    postUrl: actorData?.activity?.latestPostUrl || actorData?.postUrl || lead.link,
    posted_at_iso: actorData?.activity?.latestPostDate || actorData?.posted_at_iso,
    postDate: actorData?.postDate || actorData?.posted_at_raw,
    postText: actorData?.activity?.latestPostText || actorData?.postText,
    time_source: actorData?.time_source,
    status: actorData?.status
  };

  const recentPosts = uniquePosts(
    [targetPost, ...structuredPosts, ...legacyPosts]
      .map(normalizePost)
      .filter((post) => post.url || post.date || post.text)
  );
  const datedPosts = recentPosts
    .filter((post) => post.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const latestPost = datedPosts[0] || null;
  const latestDate = safeDate(latestPost?.date);
  const daysSinceLatestActivity = latestDate
    ? Math.max(0, Math.floor((now.getTime() - latestDate.getTime()) / 86_400_000))
    : null;
  const withinActivityWindow =
    daysSinceLatestActivity !== null && daysSinceLatestActivity <= activityWindowDays;

  const pageName = String(actorData.pageName || actorData.name || '').trim();
  const about = String(actorData.about || actorData.description || '').trim();
  const combinedBusinessText = [
    pageName,
    about,
    actorData.business?.tradingStatus,
    ...(actorData.business?.chainSignals || [])
  ].join(' ');
  const explicitClosed = CLOSED_RE.test(combinedBusinessText);
  const temporaryClosed = TEMPORARILY_CLOSED_RE.test(combinedBusinessText);
  const chainSignals = Array.isArray(actorData.business?.chainSignals)
    ? actorData.business.chainSignals.filter(Boolean)
    : [];
  if (FRANCHISE_RE.test(combinedBusinessText)) chainSignals.push('Explicit franchise wording');
  if (LARGE_BUSINESS_RE.test(combinedBusinessText)) {
    chainSignals.push('Explicit national or multi-location wording');
  }

  const contact = actorData.contact || {};
  const address = actorData.address || {};
  const canonicalUrl = canonicalizeFacebookUrl(
    actorData.canonicalUrl || actorData.pageUrl || lead.link
  );
  const nameSimilarity = tokenSimilarity(lead.name, pageName);
  const wrongBusiness =
    actorData.business?.wrongBusiness === true ||
    (nameSimilarity !== null && nameSimilarity === 0 && normalizeText(lead.name).length >= 4);
  const scrape = inferScrapeState(actorData);

  return {
    schemaVersion: actorData.schemaVersion || 'ainsley-v1',
    source: actorData.source || 'facebook',
    inputUrl: actorData.inputUrl || lead.link,
    canonicalUrl,
    pageId: actorData.pageId || null,
    pageName: pageName || null,
    category: actorData.category || lead.category || null,
    about: about || null,
    address: {
      full: address.full || actorData.address || lead.address || null,
      country: address.country || lead.country || null,
      postcode: address.postcode || lead.zip || null
    },
    contact: {
      phone: contact.phone || actorData.phone || lead.phone || null,
      email: contact.email || actorData.email || lead.email || null,
      website: contact.website || actorData.website || null,
      ownerName: contact.ownerName || actorData.ownerName || lead.ownerName || null
    },
    activity: {
      latestPostDate: latestPost?.date || null,
      latestPostUrl: latestPost?.url || null,
      latestPostText: latestPost?.text || null,
      daysSinceLatestActivity,
      activityWindowDays,
      postedWithinWindow: withinActivityWindow,
      postsChecked: recentPosts.length,
      recentPosts
    },
    business: {
      tradingStatus: explicitClosed
        ? 'closed'
        : temporaryClosed
          ? 'temporarily_closed'
          : actorData.business?.tradingStatus || 'unknown',
      businessSize: actorData.business?.businessSize || 'unknown',
      isChain: Boolean(actorData.business?.isChain),
      isFranchise: Boolean(actorData.business?.isFranchise || FRANCHISE_RE.test(combinedBusinessText)),
      isLargeBusiness: Boolean(
        actorData.business?.isLargeBusiness || LARGE_BUSINESS_RE.test(combinedBusinessText)
      ),
      chainSignals: [...new Set(chainSignals)],
      wrongBusiness,
      nameSimilarity
    },
    evidence: actorData.evidence || {
      activityUrls: recentPosts.map((post) => post.url).filter(Boolean),
      contactSourceUrls: canonicalUrl ? [`${canonicalUrl}?sk=about_contact_and_basic_info`] : []
    },
    scrape,
    duplicateKey: buildDuplicateKey(lead, actorData)
  };
}

export function determineAinsleyVerdict(
  evidence,
  { knownDuplicateKeys = [] } = {}
) {
  const known = new Set(knownDuplicateKeys.map((key) => String(key).toLowerCase()));
  const duplicate =
    evidence.duplicateKey && known.has(String(evidence.duplicateKey).toLowerCase());

  if (duplicate) {
    return { verdict: 'FAIL', reasonCode: 'DUPLICATE_BUSINESS' };
  }
  if (evidence.scrape.notFound) {
    return { verdict: 'FAIL', reasonCode: 'BUSINESS_PAGE_NOT_FOUND' };
  }
  if (evidence.business.wrongBusiness) {
    return { verdict: 'FAIL', reasonCode: 'WRONG_BUSINESS' };
  }
  if (
    evidence.business.tradingStatus === 'closed' ||
    evidence.business.tradingStatus === 'inactive'
  ) {
    return { verdict: 'FAIL', reasonCode: 'NOT_TRADING' };
  }
  if (
    evidence.business.isChain ||
    evidence.business.isFranchise ||
    evidence.business.isLargeBusiness
  ) {
    return { verdict: 'FAIL', reasonCode: 'LARGE_CHAIN_OR_FRANCHISE' };
  }
  if (evidence.scrape.blocked || evidence.scrape.loginRequired) {
    return { verdict: 'MANUAL_REVIEW', reasonCode: 'SCRAPE_BLOCKED' };
  }
  if (!evidence.activity.latestPostDate) {
    return { verdict: 'MANUAL_REVIEW', reasonCode: 'NO_DATED_ACTIVITY' };
  }
  if (!evidence.activity.postedWithinWindow) {
    return { verdict: 'FAIL', reasonCode: 'NO_ACTIVITY_WITHIN_SIX_MONTHS' };
  }
  if (evidence.scrape.partial) {
    return { verdict: 'MANUAL_REVIEW', reasonCode: 'PARTIAL_EVIDENCE' };
  }
  return { verdict: 'PASS', reasonCode: 'ACTIVE_TRADING_BUSINESS' };
}

function contactSummary(contact) {
  const found = [
    contact.phone ? 'phone' : '',
    contact.email ? 'email' : '',
    contact.website ? 'website' : ''
  ].filter(Boolean);
  if (!found.length) return 'No public phone, email, or website was found.';
  return `${found.join(' and ')} found.`;
}

export function buildAinsleyComment(validation, evidence) {
  const days = evidence.activity.daysSinceLatestActivity;
  const activityText =
    days === null
      ? 'No reliable dated activity was found.'
      : days === 0
        ? 'Latest activity was today.'
        : `Latest activity was ${days} day${days === 1 ? '' : 's'} ago.`;

  const messages = {
    ACTIVE_TRADING_BUSINESS: `Active independent business. ${activityText} ${contactSummary(evidence.contact)}`,
    DUPLICATE_BUSINESS: 'Duplicate business record based on its normalized business identifier.',
    BUSINESS_PAGE_NOT_FOUND: 'The supplied business page was not found or is unavailable.',
    WRONG_BUSINESS: 'The supplied page appears to belong to a different business.',
    NOT_TRADING: 'The business appears closed or no longer trading.',
    LARGE_CHAIN_OR_FRANCHISE: 'The business appears to be a large chain or franchise.',
    SCRAPE_BLOCKED: 'The Facebook page was blocked or required login; manual review is required.',
    NO_DATED_ACTIVITY: 'No reliable dated business activity was found; manual review is required.',
    NO_ACTIVITY_WITHIN_SIX_MONTHS: `No activity was found within the ${evidence.activity.activityWindowDays}-day window. ${activityText}`,
    PARTIAL_EVIDENCE: `Only partial business evidence was collected. ${activityText}`
  };
  return messages[validation.reasonCode] || 'Manual review is required.';
}

export function buildAinsleyResponse(
  inputLead,
  actorData,
  {
    activityWindowDays = DEFAULT_ACTIVITY_WINDOW_DAYS,
    knownDuplicateKeys = [],
    now = new Date()
  } = {}
) {
  const lead = normalizeLead(inputLead);
  const evidence = normalizeActorEvidence(actorData, lead, {
    activityWindowDays,
    now
  });
  const validation = determineAinsleyVerdict(evidence, { knownDuplicateKeys });
  const comment = buildAinsleyComment(validation, evidence);
  const enrichedLead = {
    ...lead,
    phone: evidence.contact.phone || lead.phone,
    ownerName: evidence.contact.ownerName || lead.ownerName,
    email: evidence.contact.email || lead.email,
    comment,
    passFail: validation.verdict
  };

  return {
    success: true,
    profile: AINSLEY_PROFILE,
    lead: enrichedLead,
    validation: { ...validation, comment },
    evidence: {
      canonicalUrl: evidence.canonicalUrl,
      pageId: evidence.pageId,
      pageName: evidence.pageName,
      latestPostDate: evidence.activity.latestPostDate,
      latestPostUrl: evidence.activity.latestPostUrl,
      daysSinceLatestActivity: evidence.activity.daysSinceLatestActivity,
      activityWindowDays: evidence.activity.activityWindowDays,
      postsChecked: evidence.activity.postsChecked,
      tradingStatus: evidence.business.tradingStatus,
      businessSize: evidence.business.businessSize,
      chainSignals: evidence.business.chainSignals,
      contact: evidence.contact,
      address: evidence.address,
      activityUrls: evidence.evidence.activityUrls || [],
      duplicateKey: evidence.duplicateKey
    },
    scrape: evidence.scrape
  };
}
