// server.js  (OpenAI backend)
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 4000;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN; // e.g. https://your-app.vercel.app
app.use(cors({
  origin: FRONTEND_ORIGIN ? [FRONTEND_ORIGIN] : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

app.get('/health', (_req, res) => res.json({ ok: true, provider: 'openai' }));

app.post('/validate', async (req, res) => {
  try {
    const { lead } = req.body || {};
    if (!lead) return res.status(400).json({ error: 'Lead data is required.' });

    const prompt = `You are an expert business lead validator. Analyze this business lead and determine if it's a good prospect for a UK-based B2B sales team.

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
- Business relocations or expansions
- New ownership/management changes
- Business types that typically need B2B services
- Must have phone numbers
- Must be in serviceable UK locations

Bad leads are:
- Education sector
- Long-established businesses
- Non-commercial entities
- Outside UK mainland/banned areas
- Clearly not needing B2B services
- Missing essential contact info

CRITICAL FACTORS:
1. Timing (new vs established)
2. Business Type fit
3. Contactability
4. Location serviceability
5. Conversion likelihood

Return a single valid JSON object ONLY:
{
  "verdict": "GOOD" | "BAD" | "UNCLEAR",
  "reasoning": "Detailed explanation focusing on timing, business type, and sales opportunity potential",
  "confidence": 85,
  "key_factors": ["Primary reasons"],
  "red_flags": ["Concerns"],
  "opportunity_score": 75,
  "recommended_action": "Specific next step"
}`;

    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server.' });

    const model = process.env.MODEL || 'gpt-4o-mini';
    const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';

    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
        // Ask the model to return strict JSON
        response_format: { type: 'json_object' }
      })
    });

    const raw = await r.text();
    if (!r.ok) {
      console.error('OpenAI API error:', raw);
      return res.status(r.status).json({ error: 'OpenAI API error', details: raw });
    }

    const data = JSON.parse(raw);
    const responseText = data?.choices?.[0]?.message?.content || '{}';

    // Keep the same shape the frontend expects
    return res.json({ content: [{ text: responseText }] });
  } catch (e) {
    console.error('Validate error:', e);
    return res.status(500).json({ error: 'Failed to get AI analysis.' });
  }
});

app.listen(PORT, () => {
  console.log(`OpenAI backend listening on ${PORT}`);
});
