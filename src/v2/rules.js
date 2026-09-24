// Validator v2 — Stage 1: free, deterministic rule engine.
//
// Design rule (TECHIES_VALIDATION_SPEC_V1 §4): Stage 1 only REJECTS what it can
// reject with very high certainty. Everything semantic (is this a real opening?
// is it about this business?) goes to Stage 2. Keyword hits are computed here as
// FACTS for the model, never as a rejection on their own — production previously
// lost real leads to aggressive regex filtering and we must not recreate that.
import { qualifySearchPost } from '../cot-events.js';
import { normalizeLead } from '../card-data.js';

export const RULES_VERSION = 'techies-rules-v1';

// Hard exclusions from the prompt's "Bad leads" list, now enforced in code.
// Northern Ireland (BT), Isle of Man (IM), Guernsey (GY), Jersey (JE).
const BANNED_POSTCODE_AREAS = ['BT', 'IM', 'GY', 'JE'];
// Republic of Ireland Eircode, e.g. D02 X285 / A65 F4E2.
const EIRCODE = /\b[AC-FHKNPRTV-Y]\d[\dW]\s?[\dAC-FHKNPRTV-Y]{4}\b/i;
const NON_UK_PLACE = /\b(?:republic of ireland|eire|co\. (?:dublin|cork|galway|kerry|mayo|clare|donegal|limerick|wexford|wicklow|kildare|meath)|northern ireland|isle of man|guernsey|jersey)\b/i;

// Prohibited business types — matched on the Industry Type field only, where a
// hit is near-certain. Captions mentioning these words go to Stage 2 instead.
const PROHIBITED_INDUSTRY = [
  ['education', /\b(?:school|academy|nursery|pre-?school|tutor(?:ing)?|training cent(?:re|er)|college|university|education)\b/i],
  ['legal', /\b(?:solicitors?|law firm|legal services|barristers?)\b/i],
  ['non_commercial', /\b(?:church|charity|charitable|mosque|temple|place of worship|non-?profit)\b/i]
];

// Named national chains. Exact-name match on the company/page name only.
const KNOWN_CHAINS = [
  'greggs', 'costa coffee', 'costa', 'starbucks', "mcdonald's", 'mcdonalds', 'subway', 'kfc',
  'burger king', 'domino\'s', 'dominos', 'pizza hut', 'nando\'s', 'nandos', 'tesco', 'sainsbury\'s',
  'sainsburys', 'asda', 'morrisons', 'aldi', 'lidl', 'co-op', 'boots', 'superdrug', 'wetherspoon',
  'jd wetherspoon', 'pret a manger', 'caffe nero', 'toolstation', 'screwfix', 'b&m', 'home bargains',
  'poundland', 'specsavers', 'vision express', 'timpson', 'card factory', 'savers', 'iceland'
];

const MINOR_UPDATE = /\b(?:new menu|new items?|new pricelist|price list|new services?|new offers?|new decor|new look|renovated|refurbished|new paint|new equipment|new furniture|new stand|new display|new staff|new team member|upstairs|new section|new floor)\b/i;
const PREMISES_SEARCH = /\b(?:looking for (?:new |a new |additional )?(?:premises|unit|shop|site)|on the hunt for (?:a )?new (?:unit|premises|shop)|viewing (?:sites|units|premises)|in talks to take on)\b/i;
const SECOND_SITE = /\b(?:second (?:shop|store|salon|site|branch|location|clinic|unit)|new branch|another branch|additional (?:site|location|premises))\b/i;
const ROUTINE_REOPEN = /\b(?:we(?:'re| are) back|back open|open again|reopen(?:ing)? (?:after|from|on))\b/i;

const lc = value => (typeof value === 'string' ? value : '').toLowerCase().replace(/[’‘]/g, "'");

export function captionOf(lead) {
  const raw = lead?.fetchResults?.rawData || lead?.fetchResults || {};
  return raw.postText || lead?.['Post Caption'] || lead?.['Post Text'] || '';
}

function postSampleSize(lead) {
  const f = lead?.fetchResults || {};
  const found = [f.rawData?.activity?.recentPosts, f.rawData?.previousPosts, f.activity?.recentPosts, f.previousPosts]
    .find(v => Array.isArray(v) && v.length);
  return found ? found.length : null;
}

export function postcodeArea(postcode) {
  const m = String(postcode || '').trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  return m ? m[1] : null;
}

/** Deterministic facts handed to Stage 2 (the model never recomputes these). */
export function computeFacts(lead) {
  const caption = captionOf(lead);
  const text = lc(caption);
  const event = qualifySearchPost({ message: caption });
  const n = normalizeLead(lead);
  return {
    has_caption: Boolean(text.trim()),
    event_signal: event.qualified ? event.signal : null,
    event_rule_reason: event.qualified ? null : event.reason,
    has_opening_keywords: event.signal === 'opening' || /\b(?:grand opening|now open|officially open|opening soon|soft opening)\b/.test(text),
    has_relocation_keywords: event.signal === 'relocation' || /\b(?:new location|we've moved|relocated to|moving to|new address|new premises)\b/.test(text),
    has_ownership_keywords: event.signal === 'ownership' || /\b(?:under new management|new owners?|taken over|new ownership)\b/.test(text),
    has_second_site_keywords: SECOND_SITE.test(text),
    has_premises_search_keywords: PREMISES_SEARCH.test(text),
    has_minor_update_keywords: MINOR_UPDATE.test(text),
    has_routine_reopen_keywords: ROUTINE_REOPEN.test(text),
    post_sample_size: postSampleSize(lead), // bounded sample, never a lifetime count
    page_maturity: 'unknown',
    postcode_area: postcodeArea(n.zip),
    company_name: n.name || lead?.['Company Name'] || ''
  };
}

/**
 * Stage 1 decision.
 * @returns {{decision:'REJECT'|'CONTINUE'|'NEEDS_EVIDENCE', reasons:string[], facts:object}}
 */
export function runRules(lead) {
  const facts = computeFacts(lead);
  const reasons = [];
  const n = normalizeLead(lead);
  const industry = String(lead?.['Industry Type'] || '');
  const location = [n.address, n.country === 'United Kingdom' ? '' : n.country, lead?.['Address 2'], lead?.['Address 2 (Village/Town/City)'], lead?.County]
    .filter(Boolean).join(' ');
  const postcode = normalizeLead(lead).zip || '';

  if (facts.postcode_area && BANNED_POSTCODE_AREAS.includes(facts.postcode_area)) reasons.push(`banned_postcode:${facts.postcode_area}`);
  if (EIRCODE.test(String(postcode)) && !facts.postcode_area) reasons.push('non_uk_location:eircode');
  if (NON_UK_PLACE.test(location)) reasons.push('non_uk_location');
  for (const [name, re] of PROHIBITED_INDUSTRY) if (re.test(industry)) reasons.push(`prohibited_industry:${name}`);
  const name = lc(facts.company_name).replace(/\s+(?:ltd|limited|plc)\.?$/, '').trim();
  if (name && KNOWN_CHAINS.includes(name)) reasons.push('known_chain');
  if (['historical_event_only', 'personal_or_employment_move', 'recruitment_only'].includes(facts.event_rule_reason)) {
    reasons.push(`excluded_event:${facts.event_rule_reason}`);
  }
  if (lead?.duplicate === true || lead?.isDuplicate === true) reasons.push('duplicate');

  if (reasons.length) return { decision: 'REJECT', reasons, facts, version: RULES_VERSION };
  if (!facts.has_caption) return { decision: 'NEEDS_EVIDENCE', reasons: ['missing_caption'], facts, version: RULES_VERSION };
  return { decision: 'CONTINUE', reasons: [], facts, version: RULES_VERSION };
}
