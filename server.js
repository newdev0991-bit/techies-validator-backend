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

    const prompt = `... (same prompt you already have) ...`;

    // ---- OpenAI call (or swap in Gemini if you chose that path) ----
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server.' });

    const model = process.env.MODEL || 'gpt-4o-mini';
    const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';

    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' }   // forces JSON
      })
    });

    const raw = await r.text();
    if (!r.ok) {
      console.error('OpenAI API error:', raw);
      return res.status(r.status).json({ error: 'OpenAI API error', details: raw });
    }
    const data = JSON.parse(raw);
    const responseText = data?.choices?.[0]?.message?.content || '{}';

    // keep the same shape your frontend expects
    res.json({ content: [{ text: responseText }] });
  } catch (e) {
    console.error('Validate error:', e);
    res.status(500).json({ error: 'Failed to get AI analysis.' });
  }
}

// expose BOTH routes so either frontend path works
app.post('/validate', analyzeHandler);
app.post('/analyze', analyzeHandler);

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}. Allowlist:`, allowlist);
});
