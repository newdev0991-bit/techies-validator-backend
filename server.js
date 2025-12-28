// server.js — OpenAI backend (ESM). package.json should include: { "type": "module" }
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ApifyClient } from 'apify-client';

const app = express();
const PORT = process.env.PORT || 4000;

/* ---------- CORS allowlist (Vercel + localhost) ---------- */
const rawAllow = process.env.FRONTEND_ORIGIN || process.env.ALLOWED_ORIGINS || '';
const allowlist = ['http://localhost:3000', ...rawAllow.split(',').map(s => s.trim()).filter(Boolean)];

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // curl/Postman/no-origin
    return allowlist.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));               // preflight
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

app.get('/health', (_req, res) => res.json({ ok: true, provider: 'openai' }));

/**
 * Calculate lead freshness based on posted_at_iso timestamp
 * Returns structured freshness object for frontend consumption
 */
function calculateLeadFreshness(posted_at_iso) {
  // Return null object if no date provided
  if (!posted_at_iso) {
    return {
      isFresh: null,
      daysOld: null,
      postAgeHours: null,
      timestamp: null,
      status: 'Unknown - No post date available',
      scrapedData: false
    };
  }

  try {
    // Parse the ISO timestamp
    const postedDate = new Date(posted_at_iso);
    const now = new Date();

    // Validate the parsed date
    if (isNaN(postedDate.getTime())) {
      console.warn(`[freshness] Invalid date format: ${posted_at_iso}`);
      return {
        isFresh: null,
        daysOld: null,
        postAgeHours: null,
        timestamp: posted_at_iso,
        status: 'Unknown - Invalid date format',
        scrapedData: false
      };
    }

    // Check if date is in the future (potential timezone issue or data error)
    if (postedDate > now) {
      console.warn(`[freshness] Future date detected: ${posted_at_iso}. Treating as fresh.`);
      return {
        isFresh: true,
        daysOld: 0,
        postAgeHours: 0,
        timestamp: posted_at_iso,
        status: 'Fresh - Posted today or future scheduled',
        scrapedData: true
      };
    }

    // Calculate time difference
    const diffMs = now - postedDate;
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    // Determine freshness (24-hour threshold)
    const isFresh = diffHours <= 24;

    // Generate human-readable status
    let status;
    if (diffHours <= 1) {
      status = 'Fresh - Posted within the last hour';
    } else if (diffHours <= 24) {
      status = `Fresh - Posted ${diffHours.toFixed(1)} hours ago`;
    } else if (diffDays === 1) {
      status = 'Stale - Posted 1 day ago';
    } else if (diffDays <= 7) {
      status = `Stale - Posted ${diffDays} days ago`;
    } else if (diffDays <= 30) {
      status = `Stale - Posted ${diffDays} days ago (${Math.floor(diffDays / 7)} weeks)`;
    } else {
      status = `Stale - Posted ${diffDays} days ago (${Math.floor(diffDays / 30)} months)`;
    }

    console.log(`[freshness] Calculated for ${posted_at_iso}: isFresh=${isFresh}, ageHours=${diffHours.toFixed(1)}`);

    return {
      isFresh,
      daysOld: diffDays,
      postAgeHours: parseFloat(diffHours.toFixed(2)),
      timestamp: posted_at_iso,
      status,
      scrapedData: true
    };
  } catch (error) {
    console.error(`[freshness] Error calculating freshness:`, error.message);
    return {
      isFresh: null,
      daysOld: null,
      postAgeHours: null,
      timestamp: posted_at_iso,
      status: 'Unknown - Calculation error',
      scrapedData: false
    };
  }
}

function buildPrompt(lead) {
  // Format previousPosts array into readable list
  const previousPosts = lead?.fetchResults?.rawData?.previousPosts || lead?.fetchResults?.previousPosts || [];
  const postsCount = Array.isArray(previousPosts) ? previousPosts.length : 0;
  const formattedPosts = Array.isArray(previousPosts) && previousPosts.length > 0
    ? previousPosts.slice(0, 10).map((post, idx) => `${idx + 1}. ${post}`).join('\n  ')
    : 'No previous posts available';

  // Extract post caption/text
  const postCaption = lead?.fetchResults?.rawData?.postText || lead?.fetchResults?.postText || 'Not provided';

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
- Posted At: ${lead?.fetchResults?.rawData?.posted_at_iso || 'Not provided'}
- Post Caption/Text: ${postCaption}
- Previous Posts (Total: ${postsCount}):
  ${formattedPosts}

VALIDATION CONTEXT:
You're evaluating leads for a UK-based B2B service company. Good leads are:
- New businesses or grand openings (Note: freshness is calculated automatically by the system)
- Business relocations or expansions to new locations
- New ownership/management changes
- Businesses that genuinely need B2B services (restaurants, retail shops, offices, salons, etc.)
- Must have phone numbers for contact
- Must be in serviceable UK locations

SEMANTIC INDICATORS TO LOOK FOR IN POST CAPTION:
✓ New business: "grand opening", "now open", "officially open", "opening soon", "soft opening"
✓ Relocation: "new location", "we've moved", "relocated to", "moving to", "new address", "new premises"
✓ New ownership: "under new management", "new owner", "taken over", "new ownership"
✓ Business context: Must mention the business itself is new/moving, not just a product/service

POSTING HISTORY ANALYSIS:
✓ New business page: Few total posts (< 20), irregular posting, recently created
✓ Established business: Many posts (> 50), regular posting history, consistent engagement

Bad leads are:
- Education sector (schools, academies, nurseries, tutoring centers, training centers)
- Businesses that have been open for months/years already
- Non-commercial entities (churches, charities, personal blogs, family businesses)
- Locations outside UK mainland or in banned areas (Ireland, Northern Ireland, Guernsey, Jersey, Isle of Man)
- Businesses clearly not needing B2B services
- Missing essential contact information

MINOR UPDATES TO REJECT (Not new businesses):
✗ New products/services: "new menu", "new items", "new pricelist", "new services", "new offers"
✗ Cosmetic changes: "new decor", "new look", "renovated", "refurbished", "new paint"
✗ Partial expansions: "upstairs only", "new section", "new floor", "expansion area"
✗ Equipment/furniture: "new equipment", "new furniture", "new stand", "new display"
✗ Referrals to other businesses: "check out [other business]", "shoutout to", "visit our friends"
✗ Staff changes only: "new staff", "new team member" (unless combined with "new ownership")

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
  → Caption: Opening keywords ✓, Post history: 5 posts (new page) ✓ → GOOD

- "We've relocated! Find us at our new premises on Oak Road"
  → Caption: Relocation keywords ✓, Post history: 80 posts (established) ✓ → GOOD

- "Under new management! The cafe has been taken over and we're excited to serve you"
  → Caption: New ownership keywords ✓ → GOOD

BAD LEADS:
- "Check out our new menu! Fresh items added this week"
  → Caption: Product update ✗, Post history: 200 posts ✗ → BAD

- "New pricelist for 2024! Updated rates below"
  → Caption: Pricelist update ✗ → BAD

- "Our new store stand looks amazing! Come see the display"
  → Caption: Equipment update ✗ (stand only, not business) → BAD

- "Upstairs section now open! More seating available"
  → Caption: Partial expansion ✗ (not full opening) → BAD

- "Shoutout to [Business Name] for their grand opening!"
  → Caption: Referring to other business ✗ → BAD

Analyze this lead carefully and provide your assessment in json format:

{
  "verdict": "GOOD" | "BAD" | "UNCLEAR",
  "reasoning": "Detailed explanation focusing on caption analysis, post history, timing, and business type",
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
    "total_posts": 142,
    "page_maturity": "new" | "established" | "unknown",
    "posting_pattern": "Brief description of posting pattern if discernible",
    "assessment": "Is this likely a new business page or existing business?"
  }
}

Your entire response MUST ONLY be a single, valid json object. DO NOT respond with anything other than json.`;
}

async function analyzeHandler(req, res) {
  try {
    const { lead } = req.body || {};
    if (!lead) return res.status(400).json({ error: 'Lead data is required.' });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server.' });

    const model = process.env.MODEL || 'gpt-4o-mini';
    const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';

    const systemMsg =
      'You are a strict formatter. Output must be a single valid json object only (note the lowercase word "json"). ' +
      'Include every key from the schema with non-empty strings; if information is unknown, write "Insufficient information". ' +
      'Do not add extra keys, code fences, or commentary.';

    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemMsg },         // contains lowercase "json" to satisfy JSON mode policy
          { role: 'user', content: buildPrompt(lead) }
        ],
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: 'json_object' }          // JSON mode
      })
    });

    const raw = await r.text();
    if (!r.ok) {
      console.error('OpenAI API error:', raw);
      return res.status(r.status).json({ error: 'OpenAI API error', details: raw });
    }

    const data = JSON.parse(raw);
    const text = data?.choices?.[0]?.message?.content ?? '{}';

    // Parse AI response
    const aiResponse = JSON.parse(text);

    // Calculate freshness using JavaScript (reliable, not AI)
    const posted_at_iso = lead?.fetchResults?.rawData?.posted_at_iso;
    const freshnessData = calculateLeadFreshness(posted_at_iso);

    // Merge AI analysis with calculated freshness
    const enrichedResponse = {
      ...aiResponse,
      freshness: freshnessData,
      // Override verdict to BAD if lead is stale (over 24 hours)
      verdict: freshnessData.isFresh === false ? 'BAD' : aiResponse.verdict,
      // Add freshness-related information to reasoning if stale
      reasoning: freshnessData.isFresh === false
        ? `[AUTO REJECTED: Post is ${freshnessData.daysOld} days old - exceeds 24-hour freshness requirement] ${aiResponse.reasoning}`
        : aiResponse.reasoning,
      // Add red flag if stale
      red_flags: freshnessData.isFresh === false
        ? [...(aiResponse.red_flags || []), `Lead is ${freshnessData.daysOld} days old - exceeds freshness threshold`]
        : aiResponse.red_flags
    };

    // Keep the frontend contract identical to your Claude version
    return res.json({ content: [{ text: JSON.stringify(enrichedResponse) }] });
  } catch (e) {
    console.error('Analyze error:', e);
    return res.status(500).json({ error: 'Failed to get AI analysis.' });
  }
}

app.post('/validate', analyzeHandler);
app.post('/analyze', analyzeHandler);

async function fetchResultsHandler(req, res) {
  try {
    const { lead } = req.body || {};

    // Validation
    if (!lead) {
      return res.status(400).json({ error: 'lead object is required.' });
    }

    const leadProofUrl = lead['Lead Proof URL'];
    if (!leadProofUrl) {
      return res.status(400).json({ error: 'Lead Proof URL is missing from lead object.' });
    }

    // Check for Apify token
    const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
    if (!APIFY_API_TOKEN) {
      return res.status(500).json({ error: 'Missing APIFY_API_TOKEN on server.' });
    }

    // Check for Facebook cookies
    const FACEBOOK_COOKIES = process.env.FACEBOOK_COOKIES;
    if (!FACEBOOK_COOKIES) {
      return res.status(500).json({ error: 'Missing FACEBOOK_COOKIES on server.' });
    }

    // Parse cookies from environment variable (expected as JSON array)
    let cookiesArray;
    try {
      cookiesArray = JSON.parse(FACEBOOK_COOKIES);
      if (!Array.isArray(cookiesArray)) {
        throw new Error('FACEBOOK_COOKIES must be a JSON array');
      }
    } catch (parseError) {
      console.error('[fetch-results] Failed to parse FACEBOOK_COOKIES:', parseError.message);
      return res.status(500).json({
        error: 'Invalid FACEBOOK_COOKIES format. Must be a valid JSON array.',
        details: parseError.message
      });
    }

    // Initialize Apify client
    const client = new ApifyClient({ token: APIFY_API_TOKEN });
    const actorClient = client.actor('cE441Keduu5udSFbY');

    console.log(`[fetch-results] Starting Apify actor for URL: ${leadProofUrl}`);

    // Run actor with Facebook cookies and URL
    const run = await actorClient.call({
      cookies: JSON.stringify(cookiesArray),
      startUrls: [{ url: leadProofUrl }]
    });

    console.log(`[fetch-results] Actor run completed. Run ID: ${run.id}`);

    // Extract results from dataset
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      console.error('[fetch-results] No items returned from Apify actor');
      return res.status(404).json({
        error: 'No data found for the provided URL.',
        leadProofUrl
      });
    }

    const result = items[0];
    console.log('[fetch-results] Extracted result:', JSON.stringify(result, null, 2));

    // Extract post date from various possible fields
    const postDate = result.postDate || result.posted_at_raw || result.posted_at_iso || null;

    return res.json({
      success: true,
      postDate,
      postUrl: result.postUrl || leadProofUrl,
      postText: result.postText || null,
      status: result.status || 'success',
      previousPosts: result.previousPosts || [],
      rawData: result
    });

  } catch (e) {
    console.error('[fetch-results] Error:', e.message);
    console.error('[fetch-results] Stack:', e.stack);
    return res.status(500).json({
      error: 'Failed to fetch results from Apify.',
      details: e.message
    });
  }
}

app.post('/fetch-results', fetchResultsHandler);

app.listen(PORT, () => {
  console.log(`OpenAI backend listening on ${PORT}. Allowlist:`, allowlist);
});
