// server.js  (OpenAI version shown; works the same if you use Gemini inside the handler)
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 4000;

// ----- CORS allowlist (supports FRONTEND_ORIGIN or ALLOWED_ORIGINS with commas) -----
const rawAllow = process.env.FRONTEND_ORIGIN || process.env.ALLOWED_ORIGINS || '';
const allowlist = [
  'http://localhost:3000',           // local dev
  rawAllow
].flatMap(v => (v ? v.split(',') : []))
 .map(s => s.trim())
 .filter(Boolean);

// CORS options: allow any origin if allowlist empty, else only exact matches
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);        // curl/Postman/no-origin
    if (allowlist.length === 0) return cb(null, true);
    if (allowlist.includes('*')) return cb(null, true);
    if (allowlist.some(a => origin === a)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));           // <-- handle preflight

app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

app.get('/health', (_req, res) => res.json({ ok: true, provider: 'openai' }));

// ---------- shared handler ----------
async function analyzeHandler(req, res) {
  try {
    const { lead } = req.body || {};
    if (!lead) return res.status(400).json({ error: 'Lead data is required.' });

    // 1) NEW system message with explicit lowercase 'json'
    const system = 'You are a strict formatter. Output must be a single valid json object only. No explanations, no code fences.';

    // 2) Ensure the user prompt also contains lowercase 'json'
    const prompt = `You are an expert business lead validator for UK B2B.

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

Return a single valid json object ONLY with these keys:
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        // 3) Include the system message
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 800,
        // 4) Keep JSON mode enabled
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
    return res.json({ content: [{ text: responseText }] });
  } catch (e) {
    console.error('Validate error:', e);
    return res.status(500).json({ error: 'Failed to get AI analysis.' });
  }
}


// expose BOTH routes so either frontend path works
app.post('/validate', analyzeHandler);
app.post('/analyze', analyzeHandler);

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}. Allowlist:`, allowlist);
});
