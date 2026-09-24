// Validator v2 — Stage 2: the AI's ONE job.
//
// "What real-world business event is this Facebook post describing, and is the
// event actually about this business?"  Keyword flags, post counts, freshness,
// postcodes, chains and contacts are computed in code (Stage 1 / existing
// modules) and handed in as facts; the model never recomputes them.
//
// Escalation (spec §6): gpt-5-nano -> (uncertain) gpt-5-mini -> (still
// uncertain) UNCERTAIN, which routes to evidence recovery / human review.

export const CLASSIFIER_VERSION = 'techies-event-v1';

export const EVENT_TYPES = [
  'new_opening', 'relocation', 'second_site', 'ownership_change', 'premises_search',
  'routine_reopening', 'minor_update', 'same_site_expansion', 'closure',
  'not_a_business_event', 'ambiguous'
];
export const QUALIFYING_EVENTS = new Set(['new_opening', 'relocation', 'second_site', 'ownership_change', 'premises_search']);

// USD per 1M tokens. Keep in env-overridable table; verify against current pricing.
export const PRICES = {
  'gpt-5-nano': { input: 0.05, output: 0.40 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 }
};

const SYSTEM = 'You classify one Facebook post for a UK B2B lead team. Reply with a single json object only.';

export function buildEventPrompt(caption, facts) {
  return `Decide what real-world business EVENT this post describes and whether it concerns the candidate business.

CANDIDATE BUSINESS (search author / lead name): ${facts.company_name || 'unknown'}

POST TEXT:
"""
${String(caption).slice(0, 4000)}
"""

FACTS ALREADY COMPUTED BY CODE (do not recompute, do not contradict):
${JSON.stringify({
    keyword_flags: {
      opening: facts.has_opening_keywords, relocation: facts.has_relocation_keywords,
      ownership: facts.has_ownership_keywords, second_site: facts.has_second_site_keywords,
      premises_search: facts.has_premises_search_keywords, minor_update: facts.has_minor_update_keywords,
      routine_reopen: facts.has_routine_reopen_keywords
    },
    rule_signal: facts.event_signal
  })}
Keyword flags are hints only; judge the MEANING. Do not judge freshness, location, business type, chains or contact details.

EVENT TYPES:
- new_opening: the business itself is opening / newly opened / opening soon.
- relocation: the business moved or is moving to new premises.
- second_site: a genuine additional address (new branch, second shop) while the first stays.
- ownership_change: new owner/management/operator, incl. reopening under a new operator.
- premises_search: actively looking for / viewing / in talks for new or extra premises.
- routine_reopening: back after a break, same owner and same site.
- same_site_expansion: bigger at the same address (knock-through, more seating, new room).
- minor_update: menu, products, prices, decor, equipment, staff, offers.
- closure: closing with no continuing premises.
- not_a_business_event: personal news, jobs, housing, general chat.
- ambiguous: a premises event is plausible but the text does not settle it.

ABOUT: "self" if the candidate business (or its owner posting personally) is the subject;
"third_party" if the post announces a DIFFERENT named business; "unknown" if you cannot tell.

Return json:
{"event_type": one of the types, "about": "self"|"third_party"|"unknown",
 "business_name": "business the event concerns, or empty",
 "evidence_quote": "exact short quote from POST TEXT proving the event, or empty",
 "location_quote": "exact location substring from POST TEXT, or empty",
 "confidence": 0-100}`;
}

export function parseClassification(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const event_type = EVENT_TYPES.includes(v.event_type) ? v.event_type : 'ambiguous';
  const about = ['self', 'third_party', 'unknown'].includes(v.about) ? v.about : 'unknown';
  const confidence = Math.max(0, Math.min(100, Number(v.confidence) || 0));
  return {
    event_type, about, confidence,
    business_name: String(v.business_name || '').slice(0, 200),
    evidence_quote: String(v.evidence_quote || '').slice(0, 500),
    location_quote: String(v.location_quote || '').slice(0, 200)
  };
}

/** Code (not the model) turns a classification into PASS / FAIL / UNCERTAIN. */
export function decide(c, caption, { passConfidence = 75, failConfidence = 75 } = {}) {
  if (!c) return 'UNCERTAIN';
  // Quotes must be literal: a fabricated quote means the answer is not trusted.
  if (c.evidence_quote && !String(caption).includes(c.evidence_quote)) return 'UNCERTAIN';
  if (c.event_type === 'ambiguous') return 'UNCERTAIN';
  if (QUALIFYING_EVENTS.has(c.event_type)) {
    if (!c.evidence_quote) return 'UNCERTAIN';
    return c.confidence >= passConfidence ? 'PASS' : 'UNCERTAIN';
  }
  return c.confidence >= failConfidence ? 'FAIL' : 'UNCERTAIN';
}

export function costUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.prompt_tokens || 0) * p.input + (usage.completion_tokens || 0) * p.output) / 1e6;
}

async function callModel(model, prompt, { fetchImpl = fetch, apiKey, baseUrl, timeoutMs = 30_000 }) {
  const isGpt5 = /^gpt-5/.test(model);
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    ...(isGpt5
      ? { max_completion_tokens: 2000, reasoning_effort: process.env.V2_REASONING_EFFORT || 'minimal' }
      : { max_tokens: 400, temperature: 0 })
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP_${r.status}`, latencyMs: Date.now() - started };
    const data = JSON.parse(raw);
    return {
      ok: true,
      text: data?.choices?.[0]?.message?.content || '',
      usage: data?.usage || null,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the escalation chain. Returns the final decision plus a per-step trace
 * (model, tokens, cost, latency) so the benchmark can compute cost / 1,000.
 */
export async function classifyEvent(caption, facts, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/chat/completions';
  const chain = options.models
    ?? (process.env.V2_MODELS || 'gpt-5-nano,gpt-5-mini').split(',').map(s => s.trim()).filter(Boolean);
  const thresholds = {
    passConfidence: Number(process.env.V2_PASS_CONFIDENCE) || 75,
    failConfidence: Number(process.env.V2_FAIL_CONFIDENCE) || 75,
    ...options.thresholds
  };
  if (!apiKey) return { decision: 'UNCERTAIN', classification: null, steps: [], error: 'OPENAI_NOT_CONFIGURED' };

  const prompt = buildEventPrompt(caption, facts);
  const steps = [];
  let last = null;
  for (const model of chain) {
    const res = await callModel(model, prompt, { fetchImpl: options.fetchImpl, apiKey, baseUrl, timeoutMs: options.timeoutMs });
    const classification = res.ok ? parseClassification(res.text) : null;
    const decision = decide(classification, caption, thresholds);
    steps.push({ model, ok: res.ok, error: res.error || null, decision, latencyMs: res.latencyMs,
      usage: res.usage || null, costUsd: costUsd(model, res.usage) });
    last = { decision, classification, model };
    if (decision !== 'UNCERTAIN') break; // a strong model never touches obvious cases
  }
  return {
    decision: last?.decision || 'UNCERTAIN',
    classification: last?.classification || null,
    decidedBy: last?.model || null,
    steps,
    totalCostUsd: steps.reduce((s, x) => s + (x.costUsd || 0), 0),
    version: CLASSIFIER_VERSION
  };
}
