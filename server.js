import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import pLimit from 'p-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '2', 10);
const PER_REQUEST_DELAY_MS = parseInt(process.env.PER_REQUEST_DELAY_MS || '1200', 10);

if (!OPENAI_API_KEY) {
  console.error('[FATAL] OPENAI_API_KEY is not set.');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.strip?.() || s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow server-to-server and curl
    const ok = allowedOrigins.length === 0 || allowedOrigins.includes(origin);
    if (ok) return cb(null, true);
    cb(new Error('CORS: Origin not allowed: ' + origin));
  },
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// Basic rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // max requests per IP per minute
});
app.use(limiter);

app.get('/health', (req, res) => {
  res.json({ ok: true, model: MODEL, concurrency: MAX_CONCURRENCY });
});

app.post('/test-openai', async (req, res) => {
  try {
    const ok = await callOpenAIHealth();
    res.json({ ok });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Expected lead shape (flexible keys handled on frontend):
// {
//   company, industry, phone, location, postcode, statement
// }
app.post('/analyze', async (req, res) => {
  try {
    const lead = req.body?.lead;
    if (!lead) return res.status(400).json({ error: 'Missing "lead" in body' });

    const result = await analyzeLead(lead);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/analyze-batch', async (req, res) => {
  try {
    const leads = req.body?.leads;
    if (!Array.isArray(leads)) return res.status(400).json({ error: 'Body must contain "leads": []' });

    const limit = pLimit(MAX_CONCURRENCY);
    const startTs = Date.now();

    const jobs = leads.map((lead, idx) => limit(async () => {
      const t0 = Date.now();
      const r = await analyzeLead(lead);
      const t1 = Date.now();
      if (PER_REQUEST_DELAY_MS > 0) await new Promise(r => setTimeout(r, PER_REQUEST_DELAY_MS));
      return { index: idx, durationMs: t1 - t0, ...r };
    }));

    const results = await Promise.all(jobs);
    const endTs = Date.now();
    res.json({ totalMs: endTs - startTs, count: results.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] listening on :${PORT}`);
});

/* ------------------------ Helpers ------------------------ */

async function callOpenAIHealth() {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a health-check.' },
      { role: 'user', content: 'Reply with "pong" only.' }
    ],
    temperature: 0
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI status ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  return text.toLowerCase().includes('pong');
}

function buildPrompt(lead) {
  // Normalize fields with fallbacks
  const company = lead.company || lead['Company Name'] || lead['Company'] || '';
  const industry = lead.industry || lead['Industry Type'] || lead['Industry'] || '';
  const phone = lead.phone || lead['Phone Number'] || lead['Phone'] || '';
  const location = lead.location || lead['Address 2'] || lead['City'] || lead['Location'] || '';
  const postcode = lead.postcode || lead['Post Code'] || lead['Postcode'] || '';
  const statement = lead.statement || lead['Lead Statement'] || lead['Statement'] || '';

  const compact = (s) => (s || '').toString().trim();
  const payload = {
    company: compact(company),
    industry: compact(industry),
    phone: compact(phone),
    location: compact(location),
    postcode: compact(postcode),
    statement: compact(statement),
  };

  return `You are an expert UK B2B lead validator. 
Return STRICT JSON (no commentary) with keys: verdict (GOOD|BAD|UNCLEAR), confidence (0-100), opportunity (0-100), 
reasoning (short string), key_factors (string[]), red_flags (string[]), recommended_action (short string).

Business rules (condensed):
- Prefer NEW or RECENTLY OPENED businesses; if statement implies old/uncertain -> lower opportunity.
- Disallow education (schools), local government, charities, and home-based "market stall"/online-only shops.
- Strong positives: clearly new premises, phone present, UK mainland location, traditional bricks-and-mortar.
- Weak/negative: no phone, unclear business type, PO boxes only, remote-only.
- If insufficient info -> UNCLEAR with moderate confidence.

Lead:
${JSON.stringify(payload, null, 2)}`;
}

async function analyzeLead(lead) {
  if (!OPENAI_API_KEY) {
    return {
      verdict: 'UNCLEAR',
      confidence: 10,
      opportunity: 10,
      reasoning: 'Server missing OPENAI_API_KEY; returning fallback result.',
      key_factors: ['No API key available'],
      red_flags: [],
      recommended_action: 'Set OPENAI_API_KEY on server and retry.',
      raw: { lead }
    };
  }

  const prompt = buildPrompt(lead);
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a precise JSON-only validator.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (DEBUG) console.error('[openai-error]', errText);
    // Return graceful error object
    return {
      verdict: 'UNCLEAR',
      confidence: 20,
      opportunity: 20,
      reasoning: `OpenAI error: ${resp.status}`,
      key_factors: [],
      red_flags: ['API failure'],
      recommended_action: 'Retry later or check API key/quotas.',
      raw_error: errText
    };
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    if (DEBUG) console.error('[json-parse-fail]', text);
    return {
      verdict: 'UNCLEAR',
      confidence: 30,
      opportunity: 30,
      reasoning: 'Model returned non-JSON response.',
      key_factors: [],
      red_flags: ['Non-JSON response'],
      recommended_action: 'Adjust prompt/response_format and retry.',
      raw: text
    };
  }
  return parsed;
}
