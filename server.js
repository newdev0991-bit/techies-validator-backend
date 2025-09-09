// server.js — OpenAI backend (ESM). package.json should include: { "type": "module" }
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

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

function buildPrompt(lead) {
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

VALIDATION CONTEXT:
You're evaluating leads for a UK-based B2B service company. Good leads are:
- New businesses or grand openings (recently opened within days/weeks)
- Business relocations or expansions to new locations
- New ownership/management changes
- Businesses that genuinely need B2B services (restaurants, retail shops, offices, salons, etc.)
- Must have phone numbers for contact
- Must be in serviceable UK locations

Bad leads are:
- Education sector (schools, academies, nurseries, tutoring centers, training centers)
- Businesses that have been open for months/years already
- Non-commercial entities (churches, charities, personal blogs, family businesses)
- Locations outside UK mainland or in banned areas (Ireland, Northern Ireland, Guernsey, Jersey, Isle of Man)
- Businesses clearly not needing B2B services
- Missing essential contact information

CRITICAL FACTORS TO CONSIDER:
1. Timing: Is this truly a NEW opportunity or an established business?
2. Business Type: Does this business type typically need B2B services?
3. Contact Info: Can they actually be reached for sales outreach?
4. Location: Is this in a serviceable area?
5. Opportunity Quality: How likely is this to convert to a sale?

Analyze this lead carefully and provide your assessment in json format:

{
  "verdict": "GOOD" | "BAD" | "UNCLEAR",
  "reasoning": "Detailed explanation focusing on timing, business type, and sales opportunity potential",
  "confidence": 85,
  "key_factors": ["Primary reasons for this verdict"],
  "red_flags": ["Any concerns or negative indicators"],
  "opportunity_score": 75,
  "recommended_action": "Specific next step recommendation"
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

    // Keep the frontend contract identical to your Claude version
    return res.json({ content: [{ text }] });
  } catch (e) {
    console.error('Analyze error:', e);
    return res.status(500).json({ error: 'Failed to get AI analysis.' });
  }
}

app.post('/validate', analyzeHandler);
app.post('/analyze', analyzeHandler);

app.listen(PORT, () => {
  console.log(`OpenAI backend listening on ${PORT}. Allowlist:`, allowlist);
});
