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
// OFF by default; set WEB_CONTACT_RECOVERY to on/true/1/yes to enable. A tool call on
// gpt-5.6-terra costs many times a plain completion, and in the frontend batch path it
// fires once per GOOD lead with no upstream admission gate -- an exhausted-balance
// incident on 2026-09-11 traced to exactly this plus WEB_VERDICT. Turn it on only with
// a spend cap set at OpenAI. It is still bounded when on: it only sees leads the Actor
// left without a number, is capped by WEB_SEARCH_MAX_PER_BATCH, and is inert without a key.

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

// Kept for callers/tests that still import them: the off-values remain recognised, but
// enabling is now explicit opt-in (see flagOn) because the default carried real cost.
export const OFF_VALUES = Object.freeze(['off', 'false', '0', 'no']);
export const flagOff = value => OFF_VALUES.includes(String(value ?? '').trim().toLowerCase());
export const ON_VALUES = Object.freeze(['on', 'true', '1', 'yes']);
export const flagOn = value => ON_VALUES.includes(String(value ?? '').trim().toLowerCase());
export const webContactRecoveryEnabled = (env = process.env) => flagOn(env.WEB_CONTACT_RECOVERY);

const INSTRUCTIONS = [
  'You find the publicly listed telephone number of a named UK business.',
  'Search the web. Prefer the business\'s own website, then reputable directories, public registers and booking platforms.',
  'OPEN the page before citing it: a URL you only saw in a search-result listing is not evidence and will be discarded. Report ONLY a number you have actually read on a page you opened. Never guess, never reconstruct a number from a pattern, and never return a number you cannot point to a source for.',
  'If the business runs several sites, prefer the number for the specific premises named in the location hint, and say whether the number you return is specific to that premises or is a central/head-office line.',
  'If you cannot find a number you can source, return an empty phone.',
  'Reply with a single JSON object and nothing else:',
  '{"phone": "<UK number as printed, or empty string>", "sourceUrl": "<the exact page URL you read it on, or empty string>", "isBranchSpecific": <true|false>, "notes": "<one short sentence>"}'
].join(' ');

/**
 * The pages the search tool actually fetched. Never model prose.
 *
 * Two sources, and the second matters more than it looks. `url_citation` annotations
 * only attach to prose that cites something -- and we ask for a bare JSON object, so a
 * successful lookup routinely comes back with an EMPTY annotation list. Verified live:
 * a real lookup returned the right number and source with zero annotations, which would
 * have made every recovered value fail the citation check and be discarded.
 *
 * `web_search_call` items carry an `action`, and when the tool opens a page that action
 * is `{type:'open_page', url}`. That is a better provenance record than a citation
 * anyway: it is the tool reporting what it fetched, rather than the model choosing what
 * to footnote.
 */
export function citationsFrom(payload) {
  const out = [];
  const add = (url, title) => {
    if (typeof url === 'string' && url && !out.some(c => c.url === url)) out.push({ url, title: title || '' });
  };
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      for (const note of part?.annotations || []) {
        if (note?.type === 'url_citation') add(note.url, typeof note.title === 'string' ? note.title : '');
      }
    }
    if (item?.type === 'web_search_call') {
      const action = item.action;
      if (action?.type === 'open_page') add(action.url);
      // Some actions carry the page under a different key or a list of results.
      else if (typeof action?.url === 'string') add(action.url);
      for (const result of action?.results || []) add(result?.url, result?.title);
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
  const model = env.WEB_SEARCH_MODEL || 'gpt-5.6-terra';
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
