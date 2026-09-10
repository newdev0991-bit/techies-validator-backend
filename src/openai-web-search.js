import { parsePositiveNumber } from './validation.js';

// The web-search provider behind runWebContactRecovery.
//
// This is the ONLY place in the service where a model is given a tool. It uses the
// Responses API rather than Chat Completions deliberately: Chat Completions can only
// search through the specialised *-search-preview models, which return no structured
// citation list and support no domain control. The Responses API returns
// `url_citation` annotations produced by the search tool itself, which is what lets
// runWebContactRecovery verify that the URL the model names is one it actually read.
//
// On by default; set WEB_CONTACT_RECOVERY to off/false/0/no to disable. A tool call
// costs more than a plain completion, so the phase is still bounded: it only sees leads
// the Actor left without a number, is capped by WEB_SEARCH_MAX_PER_BATCH, and is inert
// without an API key.

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

// On unless explicitly turned off, matching GOOGLE_CONTACT_FALLBACK elsewhere in the
// service. The off-switch is deliberately forgiving: an operator who means "off" and
// writes `false`, `0` or `no` must not end up paying for search because only one exact
// spelling was honoured. Anything unrecognised leaves the capability ON, so the value
// to reach for is one of these four.
export const OFF_VALUES = Object.freeze(['off', 'false', '0', 'no']);
export const flagOff = value => OFF_VALUES.includes(String(value ?? '').trim().toLowerCase());
export const webContactRecoveryEnabled = (env = process.env) => !flagOff(env.WEB_CONTACT_RECOVERY);

const INSTRUCTIONS = [
  'You find the publicly listed telephone number of a named UK business.',
  'Search the web. Prefer the business\'s own website, then reputable directories, public registers and booking platforms.',
  'Report ONLY a number you have actually read on a page you opened. Never guess, never reconstruct a number from a pattern, and never return a number you cannot point to a source for.',
  'If the business runs several sites, prefer the number for the specific premises named in the location hint, and say whether the number you return is specific to that premises or is a central/head-office line.',
  'If you cannot find a number you can source, return an empty phone.',
  'Reply with a single JSON object and nothing else:',
  '{"phone": "<UK number as printed, or empty string>", "sourceUrl": "<the exact page URL you read it on, or empty string>", "isBranchSpecific": <true|false>, "notes": "<one short sentence>"}'
].join(' ');

/** Extract the url_citation annotations the search tool produced (not model prose). */
export function citationsFrom(payload) {
  const out = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      for (const note of part?.annotations || []) {
        if (note?.type === 'url_citation' && typeof note.url === 'string') {
          out.push({ url: note.url, title: typeof note.title === 'string' ? note.title : '' });
        }
      }
    }
  }
  return out;
}

/** Concatenate the assistant's output text across output items. */
export function outputTextFrom(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n');
}

export function parseRecovery(payload) {
  const raw = outputTextFrom(payload);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    phone: typeof parsed.phone === 'string' ? parsed.phone : '',
    sourceUrl: typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : '',
    isBranchSpecific: parsed.isBranchSpecific === true,
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 300) : '',
    citations: citationsFrom(payload)
  };
}

/**
 * Build the search function runWebContactRecovery expects.
 * Returns null when disabled, so the caller simply skips the phase.
 */
export function createWebContactSearch({ env = process.env, fetchImpl = fetch } = {}) {
  if (!webContactRecoveryEnabled(env)) return null;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = env.WEB_SEARCH_MODEL || 'gpt-5.6';
  const timeoutMs = parsePositiveNumber(env.WEB_SEARCH_TIMEOUT_MS, 60_000, { min: 5_000, max: 120_000 });

  return async function searchForBusinessPhone(business, { location = '' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          tools: [{ type: 'web_search' }],
          instructions: INSTRUCTIONS,
          input: `Business: ${business}${location ? `\nLocation: ${location}` : ''}\nCountry: United Kingdom`
        })
      });
      if (!response.ok) throw new Error(`web_search_http_${response.status}`);
      return parseRecovery(await response.json());
    } finally { clearTimeout(timer); }
  };
}
