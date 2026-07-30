export const CARD_DATA_PROFILE = 'card-data-business-activity';
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

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
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
    'co',
    'roofing',
    'landscaping',
    'construction',
    'contractors',
    'contractor',
    'plumbing',
    'electrical',
    'building',
    'builders'
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

  const address = actorData.address || {};
  const canonicalUrl = canonicalizeFacebookUrl(
    actorData.canonicalUrl || actorData.pageUrl || lead.link
  );
  const nameSimilarity = tokenSimilarity(lead.name, pageName);
  const actorIdentityStatus = String(actorData.business?.identityStatus || '').toLowerCase();
  const actorIdentityConfidence = String(
    actorData.business?.identityConfidence || ''
  ).toLowerCase();
  const explicitHighConfidenceMismatch =
    actorIdentityStatus === 'mismatched' && actorIdentityConfidence === 'high';
  const identityStatus = explicitHighConfidenceMismatch
    ? 'mismatched'
    : actorIdentityStatus === 'matched' || (nameSimilarity !== null && nameSimilarity > 0)
      ? 'matched'
      : pageName
        ? 'unconfirmed'
        : 'missing';
  const identityMatched = identityStatus === 'matched';
  const contact = actorData.contact || {};
  const submittedEmail = normalizeEmail(lead.email);
  const actorEmail = normalizeEmail(contact.email || actorData.email);
  const actorEmailSource = String(
    contact.emailSource || actorData.emailSource || ''
  ).trim();
  const actorEmailVerified = Boolean(
    contact.emailVerified === true ||
      actorData.emailVerified === true ||
      ['mailto-link', 'labeled-page-contact'].includes(actorEmailSource)
  );
  const acceptedActorEmail = identityMatched && actorEmailVerified ? actorEmail : '';
  const acceptedEmail = submittedEmail || acceptedActorEmail;
  const emailSource = submittedEmail
    ? 'submitted-lead'
    : acceptedActorEmail
      ? actorEmailSource || 'verified-page-contact'
      : actorEmail
        ? identityMatched
          ? 'rejected-unverified'
          : 'rejected-unconfirmed-identity'
        : null;
  const submittedPhone = String(lead.phone || '').trim();
  const actorPhone = String(contact.phone || actorData.phone || '').trim();
  const acceptedPhone = submittedPhone || (identityMatched ? actorPhone : '');
  const submittedOwnerName = String(lead.ownerName || '').trim();
  const actorOwnerName = String(contact.ownerName || actorData.ownerName || '').trim();
  const acceptedOwnerName =
    submittedOwnerName || (identityMatched ? actorOwnerName : '');
  const acceptedWebsite = identityMatched
    ? String(contact.website || actorData.website || '').trim()
    : '';
  const wrongBusiness = explicitHighConfidenceMismatch;
  const scrape = inferScrapeState(actorData);

  return {
    schemaVersion: actorData.schemaVersion || 'card-data-v1',
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
      phone: acceptedPhone || null,
      email: acceptedEmail || null,
      emailVerified: Boolean(acceptedEmail),
      emailSource,
      website: acceptedWebsite || null,
      ownerName: acceptedOwnerName || null
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
      nameSimilarity,
      identityStatus,
      identityConfidence: explicitHighConfidenceMismatch
        ? 'high'
        : identityStatus === 'matched'
          ? 'medium'
          : 'low',
      pageNameSource: actorData.pageNameSource || actorData.business?.pageNameSource || null
    },
    evidence: actorData.evidence || {
      activityUrls: recentPosts.map((post) => post.url).filter(Boolean),
      contactSourceUrls: canonicalUrl ? [`${canonicalUrl}?sk=about_contact_and_basic_info`] : []
    },
    scrape,
    duplicateKey: buildDuplicateKey(lead, actorData)
  };
}

export function determineCardDataVerdict(
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
  if (evidence.scrape.blocked || evidence.scrape.loginRequired) {
    return { verdict: 'MANUAL_REVIEW', reasonCode: 'SCRAPE_BLOCKED' };
  }
  if (evidence.business.wrongBusiness) {
    return { verdict: 'FAIL', reasonCode: 'WRONG_BUSINESS' };
  }
  if (
    evidence.business.identityStatus === 'unconfirmed' ||
    evidence.business.identityStatus === 'missing'
  ) {
    return { verdict: 'MANUAL_REVIEW', reasonCode: 'BUSINESS_IDENTITY_UNCONFIRMED' };
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

export function buildCardDataComment(validation, evidence) {
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
    BUSINESS_IDENTITY_UNCONFIRMED:
      'The scraper could not reliably confirm that the Facebook page belongs to the submitted business; manual review is required.',
    NOT_TRADING: 'The business appears closed or no longer trading.',
    LARGE_CHAIN_OR_FRANCHISE: 'The business appears to be a large chain or franchise.',
    SCRAPE_BLOCKED: 'The Facebook page was blocked or required login; manual review is required.',
    NO_DATED_ACTIVITY: 'No reliable dated business activity was found; manual review is required.',
    NO_ACTIVITY_WITHIN_SIX_MONTHS: `No activity was found within the ${evidence.activity.activityWindowDays}-day window. ${activityText}`,
    PARTIAL_EVIDENCE: `Only partial business evidence was collected. ${activityText}`
  };
  return messages[validation.reasonCode] || 'Manual review is required.';
}

function boundedScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatActivityAge(days) {
  if (!Number.isFinite(days)) return 'No reliable dated Facebook activity was found.';
  if (days === 0) return 'The latest Facebook activity was posted today.';
  return `The latest Facebook activity was posted ${days} day${days === 1 ? '' : 's'} ago.`;
}

export function buildCardDataAnalysis(
  validation,
  evidence,
  { processingTimeMs = 0 } = {}
) {
  const successFactors = [];
  const riskFactors = [];
  const days = evidence.activity.daysSinceLatestActivity;
  const contactTypes = [
    evidence.contact.phone ? 'phone' : '',
    evidence.contact.email ? 'email' : '',
    evidence.contact.website ? 'website' : ''
  ].filter(Boolean);

  if (evidence.activity.postedWithinWindow) {
    successFactors.push(
      Number.isFinite(days)
        ? `Recent Facebook activity found ${days} day${days === 1 ? '' : 's'} ago`
        : `Dated activity found within the ${evidence.activity.activityWindowDays}-day window`
    );
  }
  if (evidence.business.tradingStatus === 'active') {
    successFactors.push('Facebook evidence indicates the business is actively trading');
  }
  if (
    !evidence.business.isChain &&
    !evidence.business.isFranchise &&
    !evidence.business.isLargeBusiness
  ) {
    successFactors.push('No chain, franchise, or large-business signals were detected');
  }
  if (contactTypes.length) {
    successFactors.push(`Public ${contactTypes.join(', ')} contact details were found`);
  }
  if (evidence.business.identityStatus === 'matched') {
    successFactors.push('The Facebook page identity aligns with the submitted business');
  }

  if (validation.reasonCode === 'DUPLICATE_BUSINESS') {
    riskFactors.push('This business matches an identifier already present in the uploaded file');
  }
  if (evidence.scrape.notFound) {
    riskFactors.push('The supplied Facebook business page was unavailable or not found');
  }
  if (evidence.business.wrongBusiness) {
    riskFactors.push('The Facebook page identity does not match the submitted business');
  }
  if (
    evidence.business.identityStatus === 'unconfirmed' ||
    evidence.business.identityStatus === 'missing'
  ) {
    riskFactors.push('The Facebook page identity could not be confirmed reliably');
  }
  if (
    evidence.business.tradingStatus === 'closed' ||
    evidence.business.tradingStatus === 'inactive'
  ) {
    riskFactors.push('Evidence indicates that the business is closed or no longer trading');
  }
  if (evidence.business.tradingStatus === 'temporarily_closed') {
    riskFactors.push('The business is marked as temporarily closed');
  }
  if (
    evidence.business.isChain ||
    evidence.business.isFranchise ||
    evidence.business.isLargeBusiness
  ) {
    riskFactors.push(
      evidence.business.chainSignals.length
        ? `Chain or franchise signals: ${evidence.business.chainSignals.join('; ')}`
        : 'The business appears to be a chain, franchise, or large organisation'
    );
  }
  if (evidence.scrape.blocked || evidence.scrape.loginRequired) {
    riskFactors.push('Facebook blocked the scrape or required login, limiting verification');
  }
  if (!evidence.activity.latestPostDate) {
    riskFactors.push('No reliable dated Facebook activity was available');
  } else if (!evidence.activity.postedWithinWindow) {
    riskFactors.push(
      `The latest activity falls outside the ${evidence.activity.activityWindowDays}-day acceptance window`
    );
  }
  if (evidence.scrape.partial) {
    riskFactors.push('Only partial Facebook evidence was collected');
  }
  if (!contactTypes.length) {
    riskFactors.push('No public phone, email, or website was found');
  }
  if (evidence.activity.postsChecked <= 1 && !evidence.scrape.blocked) {
    riskFactors.push('Limited post history was available for corroboration');
  }

  const confidenceByReason = {
    ACTIVE_TRADING_BUSINESS: 90,
    DUPLICATE_BUSINESS: 98,
    BUSINESS_PAGE_NOT_FOUND: 96,
    WRONG_BUSINESS: 92,
    BUSINESS_IDENTITY_UNCONFIRMED: 45,
    NOT_TRADING: 94,
    LARGE_CHAIN_OR_FRANCHISE: 93,
    SCRAPE_BLOCKED: 45,
    NO_DATED_ACTIVITY: 55,
    NO_ACTIVITY_WITHIN_SIX_MONTHS: 92,
    PARTIAL_EVIDENCE: 60
  };
  let confidence = confidenceByReason[validation.reasonCode] ?? 50;
  if (evidence.activity.postsChecked >= 3) confidence += 3;
  if (evidence.scrape.partial) confidence -= 8;
  if (evidence.scrape.blocked) confidence -= 5;

  let opportunityScore =
    validation.verdict === 'PASS' ? 72 : validation.verdict === 'MANUAL_REVIEW' ? 45 : 15;
  if (evidence.activity.postedWithinWindow) opportunityScore += 10;
  if (Number.isFinite(days) && days <= 30) opportunityScore += 5;
  if (contactTypes.length) opportunityScore += Math.min(8, contactTypes.length * 3);
  if (evidence.business.tradingStatus === 'active') opportunityScore += 5;
  if (validation.reasonCode === 'LARGE_CHAIN_OR_FRANCHISE') opportunityScore = 10;
  if (validation.reasonCode === 'DUPLICATE_BUSINESS') opportunityScore = 5;
  if (validation.reasonCode === 'NOT_TRADING') opportunityScore = 5;
  if (validation.reasonCode === 'BUSINESS_PAGE_NOT_FOUND') opportunityScore = 10;

  const activitySentence = formatActivityAge(days);
  const summaries = {
    ACTIVE_TRADING_BUSINESS:
      `The available Facebook evidence supports this as an active, independent business. ${activitySentence} No disqualifying closure, identity, chain, franchise, or duplicate signals were detected.`,
    DUPLICATE_BUSINESS:
      'The business evidence may otherwise be usable, but the record matches a business already identified in this upload. The duplicate rule therefore takes priority.',
    BUSINESS_PAGE_NOT_FOUND:
      'The supplied Facebook page could not be found or was unavailable, so the business and its recent activity cannot be verified from the submitted source.',
    WRONG_BUSINESS:
      'The Facebook page appears to represent a different business from the submitted lead. Using its activity or contact details would create an identity mismatch.',
    BUSINESS_IDENTITY_UNCONFIRMED:
      'The scraper could not reliably confirm the Facebook page identity against the submitted business name. Activity and contact details from this page must not be used until the identity is checked.',
    NOT_TRADING:
      'The collected evidence indicates that this business is closed or no longer trading. It does not meet the active-business requirement.',
    LARGE_CHAIN_OR_FRANCHISE:
      'The collected evidence indicates a chain, franchise, or large organisation. This falls outside the Card-data independent-business validation profile.',
    SCRAPE_BLOCKED:
      'Facebook blocked access or required login before enough evidence could be collected. The system cannot make a reliable automated decision from the available data.',
    NO_DATED_ACTIVITY:
      'No reliable dated Facebook activity was found. Without a verifiable activity date, the six-month activity requirement cannot be confirmed automatically.',
    NO_ACTIVITY_WITHIN_SIX_MONTHS:
      `The Facebook page has dated activity, but it is outside the ${evidence.activity.activityWindowDays}-day acceptance window. ${activitySentence}`,
    PARTIAL_EVIDENCE:
      `Some qualifying business evidence was collected, but the scrape was incomplete. ${activitySentence} A manual check is needed before accepting or rejecting the lead.`
  };
  const recommendedActions = {
    ACTIVE_TRADING_BUSINESS:
      'Proceed with outreach using the verified public contact details, while keeping the cited Facebook activity as validation evidence.',
    DUPLICATE_BUSINESS:
      'Do not create a second lead. Review the existing record and merge any newer contact or activity evidence.',
    BUSINESS_PAGE_NOT_FOUND:
      'Confirm the Facebook URL or locate another official business source before progressing this lead.',
    WRONG_BUSINESS:
      'Correct the Facebook URL and rerun validation against the intended business.',
    BUSINESS_IDENTITY_UNCONFIRMED:
      'Open the submitted Facebook URL and confirm the page name manually before rerunning validation.',
    NOT_TRADING:
      'Do not progress this lead unless newer evidence proves that the business has resumed trading.',
    LARGE_CHAIN_OR_FRANCHISE:
      'Do not progress this lead under the independent-business profile.',
    SCRAPE_BLOCKED:
      'Open the Facebook page manually with an authenticated session and verify identity, trading status, and recent activity.',
    NO_DATED_ACTIVITY:
      'Review the page manually or obtain another dated official source before making a decision.',
    NO_ACTIVITY_WITHIN_SIX_MONTHS:
      'Do not progress this lead unless newer dated activity can be verified.',
    PARTIAL_EVIDENCE:
      'Review the cited Facebook page manually and confirm the missing evidence before making a final decision.'
  };

  return {
    summary: summaries[validation.reasonCode] || buildCardDataComment(validation, evidence),
    recommendedAction:
      recommendedActions[validation.reasonCode] ||
      'Review the available evidence manually before progressing this lead.',
    confidence: boundedScore(confidence),
    opportunityScore: boundedScore(opportunityScore),
    processingTimeMs: Math.max(0, Math.round(Number(processingTimeMs) || 0)),
    successFactors: [...new Set(successFactors)],
    riskFactors: [...new Set(riskFactors)],
    generatedBy: 'card-data-validation-engine'
  };
}

export function buildCardDataResponse(
  inputLead,
  actorData,
  {
    activityWindowDays = DEFAULT_ACTIVITY_WINDOW_DAYS,
    knownDuplicateKeys = [],
    now = new Date(),
    processingTimeMs = 0
  } = {}
) {
  const lead = normalizeLead(inputLead);
  const evidence = normalizeActorEvidence(actorData, lead, {
    activityWindowDays,
    now
  });
  const validation = determineCardDataVerdict(evidence, { knownDuplicateKeys });
  const comment = buildCardDataComment(validation, evidence);
  const analysis = buildCardDataAnalysis(validation, evidence, { processingTimeMs });
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
    profile: CARD_DATA_PROFILE,
    lead: enrichedLead,
    validation: { ...validation, comment },
    analysis,
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
      identityStatus: evidence.business.identityStatus,
      identityConfidence: evidence.business.identityConfidence,
      pageNameSource: evidence.business.pageNameSource,
      contact: evidence.contact,
      address: evidence.address,
      activityUrls: evidence.evidence.activityUrls || [],
      duplicateKey: evidence.duplicateKey
    },
    scrape: evidence.scrape
  };
}
