function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function error(code, message) {
  return { ok: false, error: { code, message } };
}

export function validateLeadRequestBody(body) {
  if (!isPlainObject(body)) {
    return error('INVALID_REQUEST_BODY', 'Request body must be a JSON object.');
  }
  if (!isPlainObject(body.lead)) {
    return error('INVALID_LEAD', 'The "lead" field must be a JSON object.');
  }
  if (Object.keys(body.lead).length === 0) {
    return error('EMPTY_LEAD', 'The "lead" object must contain at least one field.');
  }
  return { ok: true, lead: body.lead };
}

export function validateFacebookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return error('MISSING_FACEBOOK_URL', 'A Facebook proof URL is required.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return error('INVALID_FACEBOOK_URL', 'The Facebook proof URL is not a valid URL.');
  }
  const hostname = url.hostname.toLowerCase();
  const isFacebook = hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
  if (!['http:', 'https:'].includes(url.protocol) || !isFacebook || url.username || url.password) {
    return error('INVALID_FACEBOOK_URL', 'The proof URL must be an HTTP(S) URL on facebook.com.');
  }
  url.hash = '';
  return { ok: true, value: url.toString() };
}

export function isSuccessfulFacebookScrape(value) {
  if (!isPlainObject(value)) return false;
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  return status === 'success' && value.scrape?.success === true;
}

function stringValue(value, fallback = 'Insufficient information') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberValue(value, min = 0, max = 100) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function stringArray(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function booleanValue(value) {
  return value === true;
}

export class InvalidProviderResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidProviderResponseError';
  }
}

/** Normalize and validate the OpenAI JSON response before it reaches clients. */
export function normalizeAiResponse(value) {
  if (!isPlainObject(value)) {
    throw new InvalidProviderResponseError('OpenAI response must be a JSON object.');
  }

  const rawVerdict = typeof value.verdict === 'string' ? value.verdict.toUpperCase() : '';
  // MAYBE and NOT_A_LEAD come from the revised spec's decision logic: MAYBE is
  // incomplete or conflicting evidence, NOT_A_LEAD is ordinary content with no
  // premises event -- previously both collapsed into BAD or UNCLEAR.
  const verdict = ['GOOD', 'BAD', 'UNCLEAR', 'MAYBE', 'NOT_A_LEAD'].includes(rawVerdict) ? rawVerdict : 'UNCLEAR';
  const caption = isPlainObject(value.caption_analysis) ? value.caption_analysis : {};
  const history = isPlainObject(value.post_history_analysis) ? value.post_history_analysis : {};
  const rawMaturity = typeof history.page_maturity === 'string'
    ? history.page_maturity.toLowerCase()
    : '';
  const pageMaturity = ['new', 'established', 'unknown'].includes(rawMaturity)
    ? rawMaturity
    : 'unknown';

  return {
    verdict,
    reasoning: stringValue(value.reasoning),
    confidence: numberValue(value.confidence),
    key_factors: stringArray(value.key_factors),
    red_flags: stringArray(value.red_flags),
    opportunity_score: numberValue(value.opportunity_score),
    recommended_action: stringValue(value.recommended_action),
    business_identity: {
      relationship: ['self', 'third_party'].includes(value.business_identity?.relationship)
        ? value.business_identity.relationship : 'unknown',
      businessName: stringValue(value.business_identity?.businessName, '').slice(0, 200),
      evidenceQuote: stringValue(value.business_identity?.evidenceQuote, '').slice(0, 500),
      locationQuote: stringValue(value.business_identity?.locationQuote, '').slice(0, 160)
    },
    caption_analysis: {
      has_opening_keywords: booleanValue(caption.has_opening_keywords),
      has_relocation_keywords: booleanValue(caption.has_relocation_keywords),
      has_ownership_keywords: booleanValue(caption.has_ownership_keywords),
      has_minor_update_keywords: booleanValue(caption.has_minor_update_keywords),
      summary: stringValue(caption.summary)
    },
    post_history_analysis: {
      total_posts: history.total_posts === null || history.total_posts === undefined
        ? null : Math.max(0, numberValue(history.total_posts, 0, Number.MAX_SAFE_INTEGER)),
      page_maturity: pageMaturity,
      posting_pattern: stringValue(history.posting_pattern),
      assessment: stringValue(history.assessment)
    }
  };
}

export function validateKnownDuplicateKeys(value) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return error('INVALID_DUPLICATE_KEYS', '"knownDuplicateKeys" must be an array of strings.');
  }
  if (value.length > 10_000 || value.some(item => typeof item !== 'string')) {
    return error(
      'INVALID_DUPLICATE_KEYS',
      '"knownDuplicateKeys" must contain at most 10,000 string values.'
    );
  }
  return { ok: true, value };
}

export function parsePositiveNumber(value, fallback, { min = 1, max = 10_000 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) return fallback;
  return numeric;
}
