import { parsePositiveNumber } from './validation.js';
import { citationsFrom, outputTextFrom } from './openai-web-search.js';

// A verdict reached WITH web evidence, for the two spec rules the pipeline cannot
// otherwise enforce.
//
// Both are marked mandatory / auto-reject, and neither is decidable from a Facebook
// scrape:
//
//   Home / residential address validation
//     "Cross-check the address against a map to confirm it resolves to a commercial
//      building rather than a private residence."
//     Today all we have is a street-name regex, and it can only warn -- residential_
//     address_suspected routes to review and never rejects. So the spec's "Automatically
//     reject ALL residential addresses" has never actually been enforceable.
//
//   Branch count / company size
//     "Under 10 branches = GOOD. 10+ branches, or a recognized national/large chain =
//      BAD."
//     Today that is a hardcoded list of ~60 brand names plus a follower-count proxy.
//     Neither counts branches, and the list cannot know a regional chain.
//
// Why this is affordable. It runs only on leads that survived admission, and the
// strict gate admits roughly 4% of intake (52 of 1,311 in the full-set audit). Paying
// search prices on 4% of posts to enforce two auto-reject rules is a far better trade
// than paying completion prices on all of them and enforcing neither.
//
// The verdict stays auditable. Every page the model read is captured from the search
// tool's own url_citation annotations -- not from model prose -- and stored on the
// analysis as web_evidence, so a verdict reached today can be explained next month.
//
// The output contract is unchanged. This returns the same JSON shape the plain call
// returns, so normalizeAiResponse, constrainAnalysisToEvidence and the whole batch
// contract downstream are untouched. If it fails or is switched off, the caller uses
// the plain call; a browsing failure must never fail a lead.

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export const webVerdictEnabled = (env = process.env) => env.WEB_VERDICT === 'on';

// Added to the existing prompt, not a replacement for it. The base prompt's evidence
// rules stay in force for everything they cover; this narrows what the web may be used
// for, so browsing cannot quietly become a second opinion on the whole lead.
export const WEB_VERDICT_INSTRUCTIONS = [
  'You may search the web, but ONLY to settle these two questions:',
  '(1) Does the lead address resolve to a COMMERCIAL premises or a PRIVATE RESIDENCE? Check maps and listings. A home address is a hard exclusion.',
  '(2) How many branches or sites does this business operate, and is it a national or regional chain? Ten or more sites, or a recognised chain, is a hard exclusion.',
  'Do NOT use the web to decide whether an opening or relocation happened, to date the post, to find contact details, or to second-guess the supplied evidence on anything else. The supplied post text and page evidence remain the only basis for those.',
  'Cite the page you read for each of the two findings. If you cannot find evidence for one, say so and leave it unknown rather than assuming.',
  'Report what you found in web_checks, and let it inform verdict and red_flags only through those two rules.'
].join(' ');

/** The two findings, normalised. Unknown is a first-class answer, never an assumption. */
export function normalizeWebChecks(value) {
  const checks = value && typeof value === 'object' ? value : {};
  const premises = String(checks.premises_type || '').toLowerCase();
  // Number(null) is 0, so an honest "I could not find out" would have been recorded as
  // "0 sites". Unknown has to survive as null all the way through.
  const raw = checks.branch_count;
  const branches = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return {
    premises_type: ['commercial', 'residential', 'unknown'].includes(premises) ? premises : 'unknown',
    premises_evidence_url: typeof checks.premises_evidence_url === 'string' ? checks.premises_evidence_url.slice(0, 500) : '',
    branch_count: Number.isFinite(branches) && branches >= 0 ? Math.round(branches) : null,
    is_chain: checks.is_chain === true,
    branch_evidence_url: typeof checks.branch_evidence_url === 'string' ? checks.branch_evidence_url.slice(0, 500) : ''
  };
}

export function parseWebVerdict(payload) {
  const raw = outputTextFrom(payload);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    analysis: parsed,
    webChecks: normalizeWebChecks(parsed.web_checks),
    citations: citationsFrom(payload)
  };
}

/**
 * Apply the two rules deterministically rather than trusting the model to have applied
 * them. The model gathers; the code decides. A finding only bites when the model can
 * point to a page in the search tool's own citation list -- the same standard web
 * contact recovery uses, for the same reason.
 */
export function applyWebChecks(analysis, webChecks, citations = []) {
  const cited = citations.map(c => c?.url).filter(Boolean);
  const redFlags = [...(analysis.red_flags || [])];
  let verdict = analysis.verdict;
  let reasoning = analysis.reasoning || '';

  const residential = webChecks.premises_type === 'residential'
    && webChecks.premises_evidence_url && cited.includes(webChecks.premises_evidence_url);
  if (residential) {
    verdict = 'BAD';
    redFlags.push(`residential_address — the address resolves to a private residence (${webChecks.premises_evidence_url})`);
    reasoning = `[Web check: the address resolves to a private residence, not a commercial premises.] ${reasoning}`;
  }

  const chain = (webChecks.is_chain === true || (webChecks.branch_count !== null && webChecks.branch_count >= 10))
    && webChecks.branch_evidence_url && cited.includes(webChecks.branch_evidence_url);
  if (chain && !residential) {
    verdict = 'BAD';
    const size = webChecks.branch_count !== null ? `${webChecks.branch_count} sites` : 'a recognised chain';
    redFlags.push(`large_brand — ${size} (${webChecks.branch_evidence_url})`);
    reasoning = `[Web check: ${size}; the client targets small independent businesses.] ${reasoning}`;
  }

  return { ...analysis, verdict, red_flags: redFlags, reasoning: reasoning.trim() };
}

/**
 * Returns null when disabled or unconfigured, so the caller falls back to the plain
 * completion. Never throws for a provider problem — a browsing failure returns null
 * and the lead is validated the ordinary way.
 */
export function createWebVerdict({ env = process.env, fetchImpl = fetch } = {}) {
  if (!webVerdictEnabled(env)) return null;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = env.WEB_VERDICT_MODEL || 'gpt-5.6';
  const timeoutMs = parsePositiveNumber(env.WEB_VERDICT_TIMEOUT_MS, 90_000, { min: 10_000, max: 180_000 });

  return async function verdictWithWebEvidence(basePrompt, systemMessage) {
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
          instructions: `${systemMessage}\n\n${WEB_VERDICT_INSTRUCTIONS}`,
          input: `${basePrompt}\n\nAlso include a "web_checks" object: {"premises_type":"commercial|residential|unknown","premises_evidence_url":"","branch_count":<number|null>,"is_chain":<true|false>,"branch_evidence_url":""}`
        })
      });
      if (!response.ok) return null;
      return parseWebVerdict(await response.json());
    } catch {
      return null;
    } finally { clearTimeout(timer); }
  };
}
