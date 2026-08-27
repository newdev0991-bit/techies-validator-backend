// server.js - OpenAI backend (ESM). package.json should include: { "type": "module" }
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ApifyClient } from 'apify-client';
import { apifyFailure, checkApifyAccess } from './src/apify-errors.js';
import {
  CARD_DATA_PROFILE,
  DEFAULT_ACTIVITY_WINDOW_DAYS,
  buildCardDataResponse,
  normalizeLead
} from './src/card-data.js';
import {
  buildCotActorInput,
  cotBatchFingerprint,
  indexCotActorItems,
  readCotBatch
} from './src/cot-batch.js';
import { applyFreshnessPolicy, evaluateLeadFreshness } from './src/freshness.js';
import {
  InvalidProviderResponseError,
  isSuccessfulFacebookScrape,
  normalizeAiResponse,
  parsePositiveNumber,
  validateFacebookUrl,
  validateKnownDuplicateKeys,
  validateLeadRequestBody
} from './src/validation.js';

const app = express();
const PORT = process.env.PORT || 4000;
app.set('trust proxy', 1);

/* ---------- CORS allowlist (Vercel + localhost) ---------- */
const configuredOrigins = [process.env.FRONTEND_ORIGIN, process.env.ALLOWED_ORIGINS]
  .filter(Boolean)
  .flatMap(value => value.split(','))
  .map(value => value.trim())
  .filter(Boolean);
const allowlist = [...new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://techies-validator2026.vercel.app',
  'https://techies-validator-frontend-2026-jehu-zachary-sedillos-projects.vercel.app',
  ...configuredOrigins
])];
const projectVercelOriginPatterns = [
  /^https:\/\/techies-validator-frontend-2026(?:-[a-z0-9]+)?\.vercel\.app$/i,
  /^https:\/\/techies-validator-frontend-2026(?:-git-[a-z0-9-]+|-[a-z0-9]+)?-jehu-zachary-sedillos-projects\.vercel\.app$/i,
  /^https:\/\/techies-validator-fro-git-[a-z0-9-]+-jehu-zachary-sedillos-projects\.vercel\.app$/i
];

const corsOptions = {
  exposedHeaders: ['Retry-After'],
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // curl/Postman/no-origin
    const allowed = allowlist.includes(origin) ||
      projectVercelOriginPatterns.some(pattern => pattern.test(origin));
    if (allowed) return cb(null, true);
    const error = new Error('Origin is not allowed.');
    error.status = 403;
    error.code = 'ORIGIN_NOT_ALLOWED';
    return cb(error, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));               // preflight
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({
  windowMs: 60_000,
  max: parsePositiveNumber(process.env.RATE_LIMIT_MAX, 60, { min: 1, max: 10_000 }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => sendError(
    res,
    429,
    'RATE_LIMITED',
    'Too many requests. Please wait and try again.'
  )
}));

app.get('/health', (_req, res) => res.json({
  ok: true,
  provider: 'openai',
  cotBatchContract: process.env.APIFY_ACTOR_CONTRACT || 'cot-data-batch-v1',
  cotBatchSize: configuredCotBatchSize()
}));

class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
  }
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function configuredCotBatchSize(value = process.env.COT_BATCH_SIZE) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 10 ? numeric : 3;
}

function configuredLeadDateOrder() {
  return process.env.LEAD_DATE_ORDER?.toUpperCase() === 'DMY' ? 'DMY' : 'MDY';
}

export function extractPostHistoryEvidence(lead) {
  const sources = [
    lead?.fetchResults?.rawData?.activity?.recentPosts,
    lead?.fetchResults?.rawData?.previousPosts,
    lead?.fetchResults?.activity?.recentPosts,
    lead?.fetchResults?.previousPosts
  ];
  const suppliedPosts = sources.find(Array.isArray) || [];
  return {
    totalPosts: suppliedPosts.length,
    displayedPosts: suppliedPosts.slice(0, 10)
  };
}

export function buildPrompt(lead) {
  const historyEvidence = extractPostHistoryEvidence(lead);
  const postsCount = historyEvidence.totalPosts;
  const formattedPosts = historyEvidence.displayedPosts.length > 0
    ? historyEvidence.displayedPosts.map((post, idx) => {
        if (typeof post === 'string') return `${idx + 1}. ${post}`;
        const date = post?.posted_at_iso || post?.posted_at_raw || post?.postDate ||
          post?.postedAt || post?.date || 'Unknown date';
        const text = post?.postText || post?.text || post?.caption || 'No caption';
        return `${idx + 1}. [${date}] ${text}`;
      }).join('\n  ')
    : 'No post history evidence was supplied';

  // Extract post caption/text
  const postCaption = lead?.fetchResults?.rawData?.postText ||
    lead?.fetchResults?.rawData?.activity?.latestPostText ||
    lead?.fetchResults?.postText ||
    'Not provided';

  return `You are an expert business lead validator. Analyze this business lead and determine if it's a good prospect for a UK-based B2B sales team.

LEAD DATA:
- Company Name: ${lead['Company Name'] || 'Not provided'}
- Industry Type: ${lead['Industry Type'] || 'Not provided'}
- Phone Number: ${lead['Phone Number'] ? 'Provided (' + lead['Phone Number'] + ')' : 'Missing'}
- Location: ${lead['Address 2 (Village/Town/City)'] || lead['Address 2'] || 'Not provided'}, ${lead['Post Code (Please Put The Full Postcode, Example: CH41 5LH)'] || lead['Post Code'] || 'No postcode'}
- Address: ${lead['Address 1 (Road/Street/Lane/Park/Industrial Estate)'] || lead['Address 1'] || 'Not provided'}
- Lead Statement: ${lead['Lead Statement'] || 'Not provided'}
- Proof URL: ${lead['Lead Proof URL'] || 'Not provided'}
- County: ${lead['County'] || 'Not provided'}
- Old Address: ${lead['Old Address? (For relocation, new branch, and moving premises only with no given address)'] || 'Not provided'}
- Post Caption/Text: ${postCaption}
- Previous Posts (Total: ${postsCount}):
  ${formattedPosts}

EVIDENCE INTEGRITY RULES:
- Use only evidence explicitly supplied above. Never invent, extrapolate, or assume post counts, dates, captions, contact details, or business history.
- post_history_analysis.total_posts MUST equal ${postsCount}. If it is 0, page_maturity MUST be "unknown" and history claims must say information is insufficient.
- Do not calculate freshness or infer a post age. The backend reconciles timestamps independently after your response.
- A proof URL or lead statement alone does not prove the age, identity, or history of a post.

VALIDATION CONTEXT:
You're evaluating leads for a UK-based B2B service company. Good leads are:
- New businesses or grand openings (Note: freshness is calculated automatically by the system)
- Business relocations or expansions to new locations
- New ownership/management changes
- Businesses that genuinely need B2B services (restaurants, retail shops, offices, salons, etc.)
- Phone numbers are strongly preferred for contact; missing numbers reduce opportunity quality
- Must be in serviceable UK locations

SEMANTIC INDICATORS TO LOOK FOR IN POST CAPTION:
- New business: "grand opening", "now open", "officially open", "opening soon", "soft opening"
- Relocation: "new location", "we've moved", "relocated to", "moving to", "new address", "new premises"
- New ownership: "under new management", "new owner", "taken over", "new ownership"
- Business context: Must mention the business itself is new/moving, not just a product/service

POSTING HISTORY ANALYSIS:
- New business page: Few total posts (< 20), irregular posting, recently created
- Established business: Many posts (> 50), regular posting history, consistent engagement
- Unknown: Missing/empty history; avoid strong conclusions and mark as unknown in post history analysis

Bad leads are:
- Education sector (schools, academies, nurseries, tutoring centers, training centers)
- Businesses that have been open for months/years already
- Non-commercial entities (churches, charities, personal blogs, non-commercial personal pages)
- Locations outside UK mainland or in banned areas (Ireland, Northern Ireland, Guernsey, Jersey, Isle of Man)
- Businesses clearly not needing B2B services
- Missing essential contact information

MINOR UPDATES TO REJECT (Not new businesses):
- New products/services: "new menu", "new items", "new pricelist", "new services", "new offers"
- Cosmetic changes: "new decor", "new look", "renovated", "refurbished", "new paint"
- Partial expansions: "upstairs only", "new section", "new floor", "expansion area"
- Equipment/furniture: "new equipment", "new furniture", "new stand", "new display"
- Referrals to other businesses: "check out [other business]", "shoutout to", "visit our friends"
- Staff changes only: "new staff", "new team member" (unless combined with "new ownership")

CRITICAL FACTORS TO CONSIDER:
1. Caption Analysis (50% weight):
   - Does the post caption explicitly mention the BUSINESS is new/opening/relocating?
   - Is it just announcing a minor update (new product/menu/pricelist)?
   - Look for opening/relocation keywords vs. product update keywords

2. Post History Analysis (50% weight):
   - How many total previous posts exist?
   - Is this a brand new page (< 20 posts) or established (> 50 posts)?
   - Does posting pattern suggest new business or regular updates from existing business?

3. Combined Signal:
   - GOOD: Opening keywords + sparse post history (new business)
   - GOOD: Relocation keywords + established history (existing business moving)
   - BAD: Product update keywords + established history (just a new menu item)
   - BAD: Opening keywords + 100+ posts (likely false positive)

4. Business Type: Does this business type typically need B2B services?
5. Contact Info: Can they actually be reached for sales outreach?
6. Location: Is this in a serviceable UK area?
7. Opportunity Quality: How likely is this to convert to a sale?

(Note: Freshness checking is handled automatically by the system - focus on business quality analysis)

EXAMPLE SCENARIOS:

GOOD LEADS:
- "Grand opening this Saturday! Come visit our new restaurant at 123 Main St"
  + Caption: Opening keywords, Post history: 5 posts (new page) + GOOD

- "We've relocated! Find us at our new premises on Oak Road"
  + Caption: Relocation keywords, Post history: 80 posts (established) + GOOD

- "Under new management! The cafe has been taken over and we're excited to serve you"
  + Caption: New ownership keywords + GOOD

BAD LEADS:
- "Check out our new menu! Fresh items added this week"
  + Caption: Product update, Post history: 200 posts + BAD

- "New pricelist for 2024! Updated rates below"
  + Caption: Pricelist update + BAD

- "Our new store stand looks amazing! Come see the display"
  + Caption: Equipment update (stand only, not business) + BAD

- "Upstairs section now open! More seating available"
  + Caption: Partial expansion (not full opening) + BAD

- "Shoutout to [Business Name] for their grand opening!"
  + Caption: Referring to other business + BAD

Analyze this lead carefully and provide your assessment in json format:

{
  "verdict": "GOOD" | "BAD" | "UNCLEAR",
  "reasoning": "Detailed explanation using only supplied caption, post history, and business evidence",
  "confidence": 85,
  "key_factors": ["Primary reasons for this verdict"],
  "red_flags": ["Any concerns or negative indicators"],
  "opportunity_score": 75,
  "recommended_action": "Specific next step recommendation",
  "caption_analysis": {
    "has_opening_keywords": true/false,
    "has_relocation_keywords": true/false,
    "has_ownership_keywords": true/false,
    "has_minor_update_keywords": true/false,
    "summary": "Brief analysis of what the caption indicates"
  },
  "post_history_analysis": {
    "total_posts": ${postsCount},
    "page_maturity": "new" | "established" | "unknown",
    "posting_pattern": "Brief description of posting pattern if discernible",
    "assessment": "Is this likely a new business page or existing business?"
  }
}

Your entire response MUST ONLY be a single, valid json object. DO NOT respond with anything other than json.`;
}

export function constrainAnalysisToEvidence(aiResponse, lead) {
  const history = extractPostHistoryEvidence(lead);
  const constrainedHistory = {
    ...aiResponse.post_history_analysis,
    total_posts: history.totalPosts
  };
  if (history.totalPosts === 0) {
    constrainedHistory.page_maturity = 'unknown';
    constrainedHistory.posting_pattern = 'Insufficient information';
    constrainedHistory.assessment = 'Insufficient information';
  }
  return {
    ...aiResponse,
    post_history_analysis: constrainedHistory
  };
}

async function analyzeLead(lead) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    throw new PublicError(503, 'OPENAI_NOT_CONFIGURED', 'Lead analysis is temporarily unavailable.');
  }

  const model = process.env.MODEL || 'gpt-4o-mini';
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';

  const systemMsg =
    'You are a strict formatter. Output must be a single valid json object only (note the lowercase word "json"). ' +
    'Include every key from the schema with appropriate types. For unknown string fields, write "Insufficient information". ' +
    'For unknown numeric fields, use 0. For unknown boolean fields, use false. For unknown enum fields, use "unknown" ' +
    '(except verdict, which should be "UNCLEAR" if unknown). Do not add extra keys, code fences, or commentary.';

  const timeoutMs = parsePositiveNumber(process.env.OPENAI_TIMEOUT_MS, 45_000, {
    min: 1_000,
    max: 120_000
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let r;
  let raw;
  try {
    r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: buildPrompt(lead) }
        ],
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: 'json_object' }
      })
    });
    raw = await r.text();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new PublicError(504, 'OPENAI_TIMEOUT', 'Lead analysis timed out. Please try again.');
    }
    throw new PublicError(502, 'OPENAI_UNAVAILABLE', 'Lead analysis provider is unavailable.');
  } finally {
    clearTimeout(timeout);
  }

  if (!r.ok) {
    console.error(`[analyze] OpenAI request failed with status ${r.status}.`);
    throw new PublicError(502, 'OPENAI_UPSTREAM_ERROR', 'Lead analysis provider returned an error.');
  }

  let aiResponse;
  try {
    const data = JSON.parse(raw);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new InvalidProviderResponseError('OpenAI response did not contain message content.');
    }
    aiResponse = constrainAnalysisToEvidence(normalizeAiResponse(JSON.parse(text)), lead);
  } catch (error) {
    console.error(`[analyze] Invalid OpenAI response: ${error.name}.`);
    throw new PublicError(
      502,
      'INVALID_OPENAI_RESPONSE',
      'Lead analysis provider returned an invalid response.'
    );
  }

  const freshnessData = evaluateLeadFreshness(lead, {
    leadDateOrder: configuredLeadDateOrder()
  });
  const policyResponse = applyFreshnessPolicy(aiResponse, freshnessData);

  const scrapedResult = lead?.fetchResults?.rawData || lead?.fetchResults || null;
  return {
    ...policyResponse,
    freshness: freshnessData,
    scraped_post_data: scrapedResult
      ? {
          text: scrapedResult.postText || null,
          author: scrapedResult.pageName || null,
          url: scrapedResult.postUrl || lead['Lead Proof URL'] || null
        }
      : null,
    apify_scraping_success: isSuccessfulFacebookScrape(scrapedResult),
    posted_at: freshnessData.timestamp,
    needs_manual_review: freshnessData.requiresManualReview
  };
}

async function analyzeHandler(req, res) {
  try {
    const payload = validateLeadRequestBody(req.body);
    if (!payload.ok) return sendError(res, 400, payload.error.code, payload.error.message);
    const enrichedResponse = await analyzeLead(payload.lead);
    // Preserve the legacy frontend contract while enriching the JSON inside it.
    return res.json({ content: [{ text: JSON.stringify(enrichedResponse) }] });
  } catch (e) {
    if (e instanceof PublicError) return sendError(res, e.status, e.code, e.message);
    console.error(`[analyze] Unexpected ${e?.name || 'Error'}.`);
    return sendError(res, 500, 'ANALYSIS_FAILED', 'Failed to analyze lead.');
  }
}

app.post('/validate', analyzeHandler);
app.post('/analyze', analyzeHandler);

export function parseFacebookCookies() {
  const raw = process.env.FACEBOOK_COOKIES;
  if (!raw) {
    throw new PublicError(503, 'FACEBOOK_AUTH_NOT_CONFIGURED', 'Facebook scraping is temporarily unavailable.');
  }
  let cookies;
  try {
    cookies = JSON.parse(raw);
  } catch {
    throw new PublicError(503, 'FACEBOOK_AUTH_INVALID', 'Facebook scraping is temporarily unavailable.');
  }
  const validCookies = Array.isArray(cookies) && cookies.length > 0 && cookies.every(cookie => {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) return false;
    if (typeof cookie.name !== 'string' || !cookie.name) return false;
    if (typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') return false;
    const rawDomain = cookie.domain.trim().toLowerCase();
    const hostname = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
    const isFacebookDomain = hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
    return isFacebookDomain;
  });
  if (!validCookies) {
    throw new PublicError(503, 'FACEBOOK_AUTH_INVALID', 'Facebook scraping is temporarily unavailable.');
  }
  return cookies;
}

async function runFacebookActor(lead, options = {}) {
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_API_TOKEN) {
    throw new PublicError(503, 'APIFY_NOT_CONFIGURED', 'Facebook scraping is temporarily unavailable.');
  }

  const normalizedLead = normalizeLead(lead);
  const linkValidation = validateFacebookUrl(normalizedLead.link);
  if (!linkValidation.ok) {
    throw new PublicError(400, linkValidation.error.code, linkValidation.error.message);
  }
  normalizedLead.link = linkValidation.value;

  const cookies = parseFacebookCookies();
  const client = new ApifyClient({ token: APIFY_API_TOKEN });
  const actorId = process.env.APIFY_ACTOR_ID || 'cE441Keduu5udSFbY';
  const actorClient = client.actor(actorId);
  const activityWindowDays = parsePositiveNumber(
    options.activityWindowDays || process.env.ACTIVITY_WINDOW_DAYS,
    DEFAULT_ACTIVITY_WINDOW_DAYS,
    { min: 1, max: 3_650 }
  );
  const maxPosts = parsePositiveNumber(
    options.maxPosts || process.env.APIFY_MAX_POSTS,
    10,
    { min: 1, max: 20 }
  );
  const waitSecs = Math.round(parsePositiveNumber(
    process.env.APIFY_WAIT_SECS,
    120,
    { min: 10, max: 300 }
  ));

  console.log(`[facebook-actor] Starting ${actorId} for ${normalizedLead.link}`);
  const run = await actorClient.call(
    {
      cookies: JSON.stringify(cookies),
      startUrls: [{ url: normalizedLead.link }],
      lead: normalizedLead,
      activityWindowDays,
      maxPosts,
      includeContactDetails: true,
      includeGoogleFallback: process.env.GOOGLE_CONTACT_FALLBACK !== 'false',
      includePageDetails: true,
      includePreviousPosts: true
    },
    { waitSecs }
  );
  const runStatus = typeof run?.status === 'string' ? run.status.toUpperCase() : '';
  if (['READY', 'RUNNING'].includes(runStatus)) {
    throw new PublicError(504, 'APIFY_TIMEOUT', 'Facebook scraping timed out. Please try again.');
  }
  if (runStatus !== 'SUCCEEDED') {
    throw new PublicError(502, 'APIFY_RUN_FAILED', 'Facebook scraper run did not complete successfully.');
  }
  if (!run?.defaultDatasetId) {
    throw new PublicError(502, 'APIFY_INVALID_RUN', 'Facebook scraper returned an invalid run.');
  }
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 10 });
  if (!items?.length) {
    return {
      schemaVersion: 'card-data-v1',
      status: 'error',
      error: 'Actor returned no dataset item.',
      inputUrl: normalizedLead.link,
      scrape: {
        success: false,
        partial: false,
        blocked: false,
        warnings: ['Actor returned no dataset item.']
      }
    };
  }

  if (items.length > 1) {
    console.warn(`[facebook-actor] Actor returned ${items.length} items; using consolidated first item.`);
  }
  if (!items[0] || typeof items[0] !== 'object' || Array.isArray(items[0])) {
    throw new PublicError(502, 'APIFY_INVALID_RESULT', 'Facebook scraper returned an invalid result.');
  }
  return items[0];
}

function buildFetchResults(result, fallbackUrl) {
  const postDate = result.postDate || result.posted_at_raw || result.posted_at_iso || null;
  return {
    success: isSuccessfulFacebookScrape(result),
    postDate,
    posted_at_iso: result.posted_at_iso || null,
    posted_at_raw: result.posted_at_raw || result.postDate || null,
    postUrl: result.postUrl || result.activity?.latestPostUrl || fallbackUrl,
    postText: result.postText || result.activity?.latestPostText || null,
    status: result.status || 'unknown',
    previousPosts: Array.isArray(result.previousPosts)
      ? result.previousPosts
      : Array.isArray(result.activity?.recentPosts)
        ? result.activity.recentPosts
        : [],
    schemaVersion: result.schemaVersion || 'legacy',
    contractVersion: result.contractVersion || null,
    actorData: result,
    rawData: result
  };
}

async function runFacebookActorBatch(rows) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new PublicError(503, 'APIFY_NOT_CONFIGURED', 'Facebook scraping is temporarily unavailable.');
  }
  const cookies = parseFacebookCookies();
  const entries = rows.map((row) => {
    const normalizedLead = normalizeLead(row.lead);
    const linkValidation = validateFacebookUrl(normalizedLead.link);
    if (!linkValidation.ok) {
      throw new PublicError(400, linkValidation.error.code, linkValidation.error.message);
    }
    normalizedLead.link = linkValidation.value;
    return {
      requestKey: row.clientRowId,
      url: linkValidation.value,
      lead: normalizedLead
    };
  });

  const client = new ApifyClient({ token });
  const actorId = process.env.APIFY_ACTOR_ID || 'cE441Keduu5udSFbY';
  const activityWindowDays = parsePositiveNumber(process.env.COT_ACTIVITY_WINDOW_DAYS, 1, {
    min: 1,
    max: 3_650
  });
  const maxPosts = parsePositiveNumber(process.env.APIFY_MAX_POSTS, 10, { min: 1, max: 20 });
  const waitSecs = Math.round(parsePositiveNumber(
    process.env.APIFY_BATCH_WAIT_SECS || process.env.APIFY_WAIT_SECS,
    300,
    { min: 10, max: 300 }
  ));
  const actorInput = buildCotActorInput(entries, cookies, {
    activityWindowDays,
    maxPosts,
    includeGoogleFallback: process.env.GOOGLE_CONTACT_FALLBACK !== 'false'
  });

  console.log(`[facebook-actor-batch] Starting ${actorId} for ${entries.length} row(s).`);
  const run = await client.actor(actorId).call(actorInput, { waitSecs });
  const runStatus = typeof run?.status === 'string' ? run.status.toUpperCase() : '';
  if (['READY', 'RUNNING'].includes(runStatus)) {
    throw new PublicError(504, 'APIFY_TIMEOUT', 'Facebook batch timed out. Please retry the saved batch.');
  }
  if (runStatus !== 'SUCCEEDED') {
    throw new PublicError(503, 'apify_unavailable', 'Facebook batch did not complete successfully.');
  }
  if (!run?.defaultDatasetId) {
    throw new PublicError(502, 'actor_contract_mismatch', 'Facebook batch returned no dataset.');
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: entries.length + 5 });
  let indexed;
  try {
    indexed = indexCotActorItems(
      entries,
      items,
      process.env.APIFY_ACTOR_CONTRACT || 'cot-data-batch-v1'
    );
  } catch (error) {
    throw new PublicError(502, 'actor_contract_mismatch', error.message);
  }
  const missing = entries.filter((entry) => !indexed.has(entry.requestKey));
  if (missing.length) {
    throw new PublicError(
      503,
      'actor_partial_batch',
      `Facebook batch omitted requestKey(s): ${missing.map((entry) => entry.requestKey).join(', ')}.`
    );
  }

  const actorRows = entries.map((entry) => indexed.get(entry.requestKey));
  const sessionBlocked = actorRows.some((item) =>
    item?.scrape?.blocked === true || item?.loginRequired === true || item?.auth_blocked_target === true
  );
  if (sessionBlocked) {
    throw new PublicError(503, 'session_blocked', 'Facebook refused the configured session.');
  }
  const retryableFailure = actorRows.some((item) => {
    const unavailable = item?.notFound === true || /not found|unavailable|doesn't exist/i.test(String(item?.error || ''));
    return !unavailable && String(item?.status || '').toLowerCase() !== 'success';
  });
  if (retryableFailure) {
    throw new PublicError(503, 'actor_row_failure', 'Facebook did not settle every row in the batch.');
  }

  return entries.map((entry, index) => buildFetchResults(actorRows[index], entry.url));
}

const completedCotBatches = new Map();
const cotBatchEvidence = new Map();
const activeCotBatches = new Map();

function cacheCotBatch(map, batchId, fingerprint, value) {
  const ttlMs = parsePositiveNumber(process.env.COT_BATCH_CACHE_TTL_MS, 21_600_000, {
    min: 60_000,
    max: 86_400_000
  });
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
  map.set(batchId, { fingerprint, value, expiresAt: now + ttlMs });
  while (map.size > 200) map.delete(map.keys().next().value);
}

function readCotBatchCache(map, batchId, fingerprint) {
  const entry = map.get(batchId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(batchId);
    return null;
  }
  if (entry.fingerprint !== fingerprint) {
    throw new PublicError(409, 'batch_id_conflict', 'batchId was already used for a different payload.');
  }
  return entry.value;
}

async function runCotValidationBatch(batchId, fingerprint, rows) {
  let fetchResultsByPosition = readCotBatchCache(cotBatchEvidence, batchId, fingerprint);
  if (!fetchResultsByPosition) {
    fetchResultsByPosition = new Array(rows.length).fill(null);
    const facebookRows = [];
    const facebookPositions = [];
    rows.forEach((row, position) => {
      const proofUrl = normalizeLead(row.lead).link;
      if (validateFacebookUrl(proofUrl).ok) {
        facebookRows.push(row);
        facebookPositions.push(position);
      }
    });
    if (facebookRows.length) {
      const scraped = await runFacebookActorBatch(facebookRows);
      facebookPositions.forEach((position, index) => {
        fetchResultsByPosition[position] = scraped[index];
      });
    }
    cacheCotBatch(cotBatchEvidence, batchId, fingerprint, fetchResultsByPosition);
  }

  const results = await Promise.all(rows.map(async (row, position) => {
    const fetchResults = fetchResultsByPosition[position];
    const leadForAnalysis = fetchResults ? { ...row.lead, fetchResults } : row.lead;
    const analysis = await analyzeLead(leadForAnalysis);
    return {
      clientRowId: row.clientRowId,
      rowIndex: row.rowIndex,
      success: true,
      lead: row.lead,
      fetchResults,
      analysis
    };
  }));
  return { success: true, batchId, results };
}

export function createCotBatchHandler({
  maxBatchSize,
  runBatchFn = runCotValidationBatch,
  completedBatchesMap = completedCotBatches,
  activeBatchesMap = activeCotBatches
} = {}) {
  const configuredMax = configuredCotBatchSize(maxBatchSize ?? process.env.COT_BATCH_SIZE);
  return async function cotBatchHandler(req, res) {
    const parsed = readCotBatch(req.body, { maxBatchSize: configuredMax });
    if (parsed.error) return sendError(res, 400, 'INVALID_BATCH', parsed.error);
    const fingerprint = cotBatchFingerprint(parsed.rows);
    try {
      const completed = readCotBatchCache(completedBatchesMap, parsed.batchId, fingerprint);
      if (completed) return res.json(completed);
      const active = activeBatchesMap.get(parsed.batchId);
      if (active) {
        if (active.fingerprint !== fingerprint) {
          return sendError(res, 409, 'batch_id_conflict', 'batchId is already running with a different payload.');
        }
        return res.json(await active.promise);
      }
      const promise = (async () => {
        const response = await runBatchFn(parsed.batchId, fingerprint, parsed.rows);
        cacheCotBatch(completedBatchesMap, parsed.batchId, fingerprint, response);
        return response;
      })();
      const reservation = { fingerprint, promise };
      activeBatchesMap.set(parsed.batchId, reservation);
      try {
        return res.json(await promise);
      } finally {
        if (activeBatchesMap.get(parsed.batchId) === reservation) activeBatchesMap.delete(parsed.batchId);
      }
    } catch (error) {
      if (error instanceof PublicError) {
        if (error.status === 503) res.set('Retry-After', '60');
        return sendError(res, error.status, error.code, error.message);
      }
      const providerFailure = apifyFailure(error);
      if (providerFailure) {
        console.error(`[validate-batch] ${JSON.stringify(providerFailure.diagnostic)}`);
        return sendError(res, providerFailure.status, providerFailure.code, providerFailure.message);
      }
      console.error('[validate-batch] Unexpected non-provider error.');
      return sendError(res, 500, 'BATCH_FAILED', 'Batch validation failed.');
    }
  };
}

async function validateBusinessHandler(req, res) {
  const startedAt = Date.now();
  try {
    const payload = validateLeadRequestBody(req.body);
    if (!payload.ok) return sendError(res, 400, payload.error.code, payload.error.message);
    const { lead } = payload;
    const profile = req.body.profile || CARD_DATA_PROFILE;
    if (profile !== CARD_DATA_PROFILE) {
      return sendError(
        res,
        400,
        'UNSUPPORTED_PROFILE',
        `Unsupported profile. Use "${CARD_DATA_PROFILE}".`
      );
    }
    const duplicateKeys = validateKnownDuplicateKeys(req.body.knownDuplicateKeys);
    if (!duplicateKeys.ok) {
      return sendError(res, 400, duplicateKeys.error.code, duplicateKeys.error.message);
    }

    const activityWindowDays = parsePositiveNumber(
      process.env.ACTIVITY_WINDOW_DAYS,
      DEFAULT_ACTIVITY_WINDOW_DAYS,
      { min: 1, max: 3_650 }
    );
    const actorData = await runFacebookActor(lead, { activityWindowDays });
    const response = buildCardDataResponse(lead, actorData, {
      activityWindowDays,
      knownDuplicateKeys: duplicateKeys.value,
      processingTimeMs: Date.now() - startedAt
    });

    // Temporary compatibility for clients that still parse content[0].text.
    return res.json({
      ...response,
      content: [{ text: JSON.stringify(response) }]
    });
  } catch (error) {
    if (error instanceof PublicError) {
      return sendError(res, error.status, error.code, error.message);
    }
    console.error(`[validate-business] Unexpected ${error?.name || 'Error'}.`);
    return sendError(res, 502, 'FACEBOOK_VALIDATION_FAILED', 'Failed to validate business.');
  }
}

app.post('/validate-business', validateBusinessHandler);

async function fetchResultsHandler(req, res) {
  try {
    const payload = validateLeadRequestBody(req.body);
    if (!payload.ok) return sendError(res, 400, payload.error.code, payload.error.message);
    const { lead } = payload;

    const normalizedLead = normalizeLead(lead);
    const leadProofUrl = normalizedLead.link;
    const linkValidation = validateFacebookUrl(leadProofUrl);
    if (!linkValidation.ok) {
      return sendError(res, 400, linkValidation.error.code, linkValidation.error.message);
    }

    const result = await runFacebookActor(lead);
    console.log(`[fetch-results] Actor completed: ${result.status || 'unknown'}`);

    const fetchResults = buildFetchResults(result, linkValidation.value);
    const freshness = evaluateLeadFreshness(
      { ...lead, fetchResults },
      { leadDateOrder: configuredLeadDateOrder() }
    );

    return res.json({
      ...fetchResults,
      freshness,
      resolvedPostDate: freshness.timestamp,
      needsManualReview: freshness.requiresManualReview
    });

  } catch (e) {
    if (e instanceof PublicError) return sendError(res, e.status, e.code, e.message);
    console.error(`[fetch-results] Unexpected ${e?.name || 'Error'}.`);
    return sendError(res, 502, 'APIFY_REQUEST_FAILED', 'Failed to fetch Facebook results.');
  }
}

app.post('/fetch-results', fetchResultsHandler);
app.post('/validate-batch', createCotBatchHandler());

app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Endpoint not found.'));

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
  if (error?.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the 1 MB limit.');
  }
  if (error?.code === 'ORIGIN_NOT_ALLOWED') {
    return sendError(res, 403, error.code, 'Request origin is not allowed.');
  }
  console.error(`[http] Unexpected ${error?.name || 'Error'}.`);
  return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
});

export { app };

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPoint === import.meta.url) {
  app.listen(PORT, () => {
    console.log(`OpenAI backend listening on ${PORT}. Allowlist:`, allowlist);
    if (process.env.APIFY_API_TOKEN) {
      const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN, maxRetries: 0, timeoutSecs: 15 });
      void checkApifyAccess(client.actor(process.env.APIFY_ACTOR_ID || 'cE441Keduu5udSFbY'));
    }
  });
}



