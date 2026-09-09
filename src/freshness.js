const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const FRESHNESS_THRESHOLD_HOURS = 24;
export const DEFAULT_FUTURE_SKEW_MINUTES = 5;
export const DEFAULT_CONFLICT_TOLERANCE_HOURS = 6;

const UK_TIME_ZONE = 'Europe/London';
const MONTHS = new Map([
  ['january', 1], ['jan', 1],
  ['february', 2], ['feb', 2],
  ['march', 3], ['mar', 3],
  ['april', 4], ['apr', 4],
  ['may', 5],
  ['june', 6], ['jun', 6],
  ['july', 7], ['jul', 7],
  ['august', 8], ['aug', 8],
  ['september', 9], ['sep', 9], ['sept', 9],
  ['october', 10], ['oct', 10],
  ['november', 11], ['nov', 11],
  ['december', 12], ['dec', 12]
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validCalendarParts({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  return Number.isInteger(year) && year >= 1970 && year <= 2100 &&
    Number.isInteger(month) && month >= 1 && month <= 12 &&
    Number.isInteger(day) && day >= 1 && day <= daysInMonth(year, month) &&
    Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
    Number.isInteger(minute) && minute >= 0 && minute <= 59 &&
    Number.isInteger(second) && second >= 0 && second <= 59;
}

const londonFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: UK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function londonPartsAt(timestampMs) {
  return Object.fromEntries(
    londonFormatter.formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
}

function timeZoneOffsetMs(timestampMs) {
  const parts = londonPartsAt(timestampMs);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return representedAsUtc - Math.trunc(timestampMs / 1000) * 1000;
}

function londonDateTimeToUtc(parts) {
  const wallClockMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    parts.millisecond || 0
  );
  let result = wallClockMs - timeZoneOffsetMs(wallClockMs);
  result = wallClockMs - timeZoneOffsetMs(result);
  return result;
}

function nextCalendarDay({ year, month, day }) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
}

function calendarResult(parts, hasTime, parser) {
  if (!validCalendarParts(parts)) {
    return { valid: false, errorCode: 'INVALID_CALENDAR_DATE', parser };
  }

  const startMs = londonDateTimeToUtc(parts);
  if (hasTime) {
    const expected = {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour || 0,
      minute: parts.minute || 0,
      second: parts.second || 0
    };
    const matchesWallClock = timestampMs => {
      const observed = londonPartsAt(timestampMs);
      return Object.entries(expected).every(([key, value]) => observed[key] === value);
    };
    if (!matchesWallClock(startMs)) {
      return { valid: false, errorCode: 'NONEXISTENT_LOCAL_TIME', parser };
    }
    if (matchesWallClock(startMs - HOUR_MS) || matchesWallClock(startMs + HOUR_MS)) {
      return { valid: false, errorCode: 'AMBIGUOUS_LOCAL_TIME', parser };
    }
    return {
      valid: true,
      normalizedTimestamp: new Date(startMs).toISOString(),
      rangeStart: new Date(startMs).toISOString(),
      rangeEnd: new Date(startMs).toISOString(),
      precision: 'instant',
      parser
    };
  }

  const tomorrow = nextCalendarDay(parts);
  const endMs = londonDateTimeToUtc({ ...tomorrow, hour: 0, minute: 0, second: 0 }) - 1;
  return {
    valid: true,
    normalizedTimestamp: new Date(startMs).toISOString(),
    rangeStart: new Date(startMs).toISOString(),
    rangeEnd: new Date(endMs).toISOString(),
    precision: 'day',
    parser
  };
}

function normalizeClock(hourText, minuteText, secondText, meridiemText) {
  let hour = Number(hourText || 0);
  const minute = Number(minuteText || 0);
  const second = Number(secondText || 0);
  const meridiem = meridiemText?.toLowerCase();

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
  }
  return { hour, minute, second };
}

/**
 * Parse timestamp evidence without relying on JavaScript's locale-dependent
 * string parser. Slash-form scraped dates are explicitly interpreted as UK
 * DD/MM/YYYY. Lead dates can opt into MDY for the source spreadsheet.
 */
export function parseDateEvidence(
  value,
  { dateOrder = 'DMY', referenceTime = null } = {}
) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { valid: false, errorCode: 'INVALID_DATE', parser: 'date' };
    const iso = value.toISOString();
    return {
      valid: true,
      normalizedTimestamp: iso,
      rangeStart: iso,
      rangeEnd: iso,
      precision: 'instant',
      parser: 'date'
    };
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { valid: false, errorCode: 'INVALID_DATE', parser: 'epoch' };
    const iso = date.toISOString();
    return {
      valid: true,
      normalizedTimestamp: iso,
      rangeStart: iso,
      rangeEnd: iso,
      precision: 'instant',
      parser: 'epoch'
    };
  }

  const text = asNonEmptyString(value);
  if (!text) return { valid: false, errorCode: 'EMPTY_DATE', parser: 'none' };

  const isoInstant = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
  const isoMatch = text.match(isoInstant);
  if (isoMatch) {
    if (!validCalendarParts({
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
      hour: Number(isoMatch[4]),
      minute: Number(isoMatch[5]),
      second: Number(isoMatch[6] || 0)
    })) {
      return { valid: false, errorCode: 'INVALID_ISO_DATE', parser: 'iso' };
    }
    const timestampMs = Date.parse(text);
    if (!Number.isFinite(timestampMs)) return { valid: false, errorCode: 'INVALID_ISO_DATE', parser: 'iso' };
    const iso = new Date(timestampMs).toISOString();
    return {
      valid: true,
      normalizedTimestamp: iso,
      rangeStart: iso,
      rangeEnd: iso,
      precision: 'instant',
      parser: 'iso'
    };
  }

  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/;
  const isoDayMatch = text.match(isoDay);
  if (isoDayMatch) {
    return calendarResult({
      year: Number(isoDayMatch[1]),
      month: Number(isoDayMatch[2]),
      day: Number(isoDayMatch[3])
    }, false, 'iso-day-uk');
  }

  const numericDate = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:[\s,]+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i;
  const numericMatch = text.match(numericDate);
  if (numericMatch) {
    const order = dateOrder === 'MDY' ? 'MDY' : 'DMY';
    const first = Number(numericMatch[1]);
    const second = Number(numericMatch[2]);
    const clock = normalizeClock(numericMatch[4], numericMatch[5], numericMatch[6], numericMatch[7]);
    if (!clock) return { valid: false, errorCode: 'INVALID_TIME', parser: `numeric-${order.toLowerCase()}` };
    return calendarResult({
      year: Number(numericMatch[3]),
      month: order === 'MDY' ? first : second,
      day: order === 'MDY' ? second : first,
      ...clock
    }, Boolean(numericMatch[4]), `numeric-${order.toLowerCase()}-uk-time`);
  }

  const namedDate = /^(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})(?:[\s,]+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i;
  const namedMatch = text.match(namedDate);
  if (namedMatch) {
    const month = MONTHS.get(namedMatch[2].toLowerCase());
    const clock = normalizeClock(namedMatch[4], namedMatch[5], namedMatch[6], namedMatch[7]);
    if (!month) return { valid: false, errorCode: 'INVALID_MONTH_NAME', parser: 'named-uk' };
    if (!clock) return { valid: false, errorCode: 'INVALID_TIME', parser: 'named-uk' };
    return calendarResult({
      year: Number(namedMatch[3]),
      month,
      day: Number(namedMatch[1]),
      ...clock
    }, Boolean(namedMatch[4]), 'named-uk');
  }

  const relative = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*(?:ago)?$/i;
  const relativeMatch = text.match(relative);
  const referenceMs = referenceTime instanceof Date
    ? referenceTime.getTime()
    : typeof referenceTime === 'string'
      ? Date.parse(referenceTime)
      : Number(referenceTime);
  if (relativeMatch && Number.isFinite(referenceMs)) {
    const amount = Number(relativeMatch[1]);
    const unitText = relativeMatch[2].toLowerCase();
    const unitMs = unitText.startsWith('m')
      ? MINUTE_MS
      : unitText.startsWith('h')
        ? HOUR_MS
        : DAY_MS;
    const newestMs = referenceMs - amount * unitMs;
    const oldestMs = newestMs - unitMs;
    return {
      valid: true,
      normalizedTimestamp: new Date(newestMs).toISOString(),
      rangeStart: new Date(oldestMs).toISOString(),
      rangeEnd: new Date(newestMs).toISOString(),
      precision: 'relative',
      parser: 'facebook-relative'
    };
  }

  const yesterday = /^yesterday(?:\s+at\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i;
  const yesterdayMatch = text.match(yesterday);
  if (yesterdayMatch && Number.isFinite(referenceMs)) {
    const referenceParts = Object.fromEntries(
      londonFormatter.formatToParts(new Date(referenceMs))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, Number(part.value)])
    );
    const previous = new Date(Date.UTC(
      referenceParts.year,
      referenceParts.month - 1,
      referenceParts.day - 1
    ));
    const clock = normalizeClock(
      yesterdayMatch[1],
      yesterdayMatch[2],
      yesterdayMatch[3],
      yesterdayMatch[4]
    );
    if (!clock) return { valid: false, errorCode: 'INVALID_TIME', parser: 'facebook-yesterday' };
    const parsed = calendarResult({
      year: previous.getUTCFullYear(),
      month: previous.getUTCMonth() + 1,
      day: previous.getUTCDate(),
      ...clock
    }, Boolean(yesterdayMatch[1]), 'facebook-yesterday');
    return parsed.valid ? { ...parsed, precision: 'relative' } : parsed;
  }

  return { valid: false, errorCode: 'UNSUPPORTED_DATE_FORMAT', parser: 'none' };
}

function parseUrl(value) {
  const text = asNonEmptyString(value);
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function isUntrustedGroupFeedUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  const path = url.pathname.toLowerCase();
  const isGroup = /^\/groups\/[^/]+/.test(path);
  const directPostPath = /\/(?:posts|permalink)\/[^/]+/.test(path);
  return isGroup && (!directPostPath || url.searchParams.has('multi_permalinks'));
}

function explicitTimestampTrust(rawData) {
  const provenance = rawData?.timestampProvenance || rawData?.provenance?.timestamp || {};
  const targetMatched = firstDefined(
    provenance.targetPostMatched,
    rawData?.targetPostMatched,
    rawData?.postMatchVerified,
    rawData?.time_target_matched
  );
  const method = firstDefined(
    provenance.method,
    provenance.source,
    rawData?.timestampSource,
    rawData?.time_target_match_method
  );
  const confidenceValue = firstDefined(provenance.confidence, rawData?.time_confidence);
  const confidence = typeof confidenceValue === 'string'
    ? confidenceValue.toLowerCase()
    : null;
  const normalizedStatus = typeof rawData?.status === 'string' ? rawData.status.toLowerCase() : null;
  const precisionValue = firstDefined(provenance.precision, rawData?.time_precision);
  const normalizedPrecision = typeof precisionValue === 'string'
    ? precisionValue.toLowerCase().replaceAll('_', '-')
    : null;
  const actorPrecision = normalizedPrecision === 'exact' || normalizedPrecision === 'exact-instant' ||
    normalizedPrecision === 'instant'
    ? 'exact'
    : normalizedPrecision?.startsWith('relative')
      ? 'relative'
      : normalizedPrecision === 'date-only' || normalizedPrecision === 'day'
        ? 'date_only'
        : 'unknown';
  const estimatedValue = firstDefined(
    provenance.estimated,
    rawData?.time_is_estimated,
    rawData?.time_estimated
  );
  const actorEstimated = typeof estimatedValue === 'boolean'
    ? estimatedValue
    : ['relative', 'date_only'].includes(actorPrecision)
      ? true
      : null;
  const scrapeSucceeded = normalizedStatus === 'success' && rawData?.scrape?.success === true;
  const scrapeFailed = normalizedStatus === 'error' || normalizedStatus === 'failed' ||
    rawData?.scrape?.success === false;
  const verifiedEvidence = scrapeSucceeded && targetMatched === true &&
    ['high', 'medium'].includes(confidence);
  return {
    explicitlyTrusted: verifiedEvidence,
    explicitlyUntrusted: scrapeFailed || targetMatched === false || confidence === 'low',
    method: asNonEmptyString(method) || null,
    actorConfidence: confidence,
    actorPrecision,
    actorEstimated
  };
}

function candidatePublicView(candidate) {
  return {
    id: candidate.id,
    label: candidate.label,
    value: candidate.value,
    normalizedTimestamp: candidate.normalizedTimestamp || null,
    rangeStart: candidate.rangeStart || null,
    rangeEnd: candidate.rangeEnd || null,
    precision: candidate.precision || null,
    provenance: candidate.provenance,
    trusted: candidate.trusted,
    confidence: candidate.confidence,
    decisionGrade: candidate.decisionGrade,
    estimated: candidate.estimated,
    valid: candidate.valid,
    parser: candidate.parser || null,
    errorCode: candidate.errorCode || null,
    classification: candidate.classification || null,
    ageHoursMin: Number.isFinite(candidate.classificationData?.ageHoursMin)
      ? Number(candidate.classificationData.ageHoursMin.toFixed(2))
      : null,
    ageHoursMax: Number.isFinite(candidate.classificationData?.ageHoursMax)
      ? Number(candidate.classificationData.ageHoursMax.toFixed(2))
      : null
  };
}

function classifyCandidate(candidate, nowMs, thresholdMs, futureSkewMs) {
  if (!candidate.valid) return { state: 'invalid' };
  const startMs = Date.parse(candidate.rangeStart);
  const endMs = Date.parse(candidate.rangeEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { state: 'invalid' };

  if (startMs > nowMs + futureSkewMs) {
    return {
      state: 'future',
      futureByHours: (startMs - nowMs) / HOUR_MS
    };
  }

  if (candidate.precision === 'instant' && startMs > nowMs) {
    return {
      state: 'fresh',
      ageHours: 0,
      ageHoursMin: 0,
      ageHoursMax: 0,
      futureSkew: true,
      futureByMinutes: (startMs - nowMs) / MINUTE_MS
    };
  }

  const effectiveEndMs = Math.min(endMs, nowMs);
  const ageMsMin = Math.max(0, nowMs - effectiveEndMs);
  const ageMsMax = Math.max(0, nowMs - startMs);
  const common = {
    ageHours: ageMsMax / HOUR_MS,
    ageHoursMin: ageMsMin / HOUR_MS,
    ageHoursMax: ageMsMax / HOUR_MS
  };

  if (ageMsMax <= thresholdMs) return { state: 'fresh', ...common };
  if (ageMsMin > thresholdMs) return { state: 'stale', ...common };
  return { state: 'indeterminate', ...common };
}

function intervalGapHours(left, right) {
  const leftStart = Date.parse(left.rangeStart);
  const leftEnd = Date.parse(left.rangeEnd);
  const rightStart = Date.parse(right.rangeStart);
  const rightEnd = Date.parse(right.rangeEnd);
  if (leftEnd < rightStart) return (rightStart - leftEnd) / HOUR_MS;
  if (rightEnd < leftStart) return (leftStart - rightEnd) / HOUR_MS;
  return 0;
}

function warning(code, message, sources = []) {
  return { code, message, sources };
}

function buildStatus(reasonCode, classification, ageHours) {
  if (reasonCode === 'DATE_CONFLICT') return 'Needs review - Conflicting post dates';
  if (reasonCode === 'UNTRUSTED_PROVENANCE') {
    return 'Needs review - Timestamp was not verified against the target Facebook post';
  }
  if (reasonCode === 'FUTURE_TIMESTAMP') return 'Needs review - Post timestamp is unexpectedly in the future';
  if (reasonCode === 'IMPRECISE_DATE') return 'Needs review - Date precision crosses the 24-hour threshold';
  if (reasonCode === 'ESTIMATED_TIMESTAMP') {
    return 'Needs review - Freshness is based on estimated or medium-confidence time evidence';
  }
  if (reasonCode === 'LOW_CONFIDENCE_DATE') return 'Needs review - Stale result is based on low-confidence date evidence';
  if (reasonCode === 'INVALID_DATE') return 'Unknown - Invalid post date';
  if (reasonCode === 'NO_DATE') return 'Unknown - No post date available';

  if (classification === 'fresh') {
    if (ageHours < 1) return 'Fresh - Posted within the last hour';
    const rounded = Number(ageHours.toFixed(1));
    return `Fresh - Posted ${pluralize(rounded, 'hour')} ago`;
  }

  const days = Math.max(1, Math.floor(ageHours / 24));
  if (days < 7) return `Stale - Posted ${pluralize(days, 'day')} ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `Stale - Posted ${pluralize(days, 'day')} ago (${pluralize(weeks, 'week')})`;
  }
  const months = Math.floor(days / 30);
  return `Stale - Posted ${pluralize(days, 'day')} ago (${pluralize(months, 'month')})`;
}

function confidenceLevel(score) {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

function describeManualReview(reasonCode) {
  const descriptions = {
    DATE_CONFLICT: 'The scraped timestamp conflicts materially with another supplied post date.',
    UNTRUSTED_PROVENANCE: 'The scraper did not prove that the timestamp belongs to the target Facebook post.',
    FUTURE_TIMESTAMP: 'A timestamp is beyond the allowed clock-skew tolerance.',
    IMPRECISE_DATE: 'Date-only evidence cannot establish which side of the exact 24-hour boundary the post falls on.',
    ESTIMATED_TIMESTAMP: 'The available timestamp is estimated, date-only, relative, or below high confidence.',
    LOW_CONFIDENCE_DATE: 'The stale result is not supported by sufficiently precise, trusted timestamp evidence.',
    INVALID_DATE: 'Post date evidence was present but could not be parsed safely.',
    NO_DATE: 'No usable post date evidence was supplied.'
  };
  return descriptions[reasonCode] || 'Freshness could not be determined safely.';
}

/**
 * Reconcile all timestamp evidence used by the legacy COT validator.
 * The function is deterministic when `now` is supplied and is safe to unit test.
 */
export function evaluateLeadFreshness(
  lead,
  {
    now = new Date(),
    thresholdHours = FRESHNESS_THRESHOLD_HOURS,
    futureSkewMinutes = DEFAULT_FUTURE_SKEW_MINUTES,
    conflictToleranceHours = DEFAULT_CONFLICT_TOLERANCE_HOURS,
    leadDateOrder = 'MDY'
  } = {}
) {
  const evaluatedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(evaluatedAt.getTime())) throw new TypeError('now must be a valid date');
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new TypeError('thresholdHours must be a positive number');
  }

  const safeLead = isPlainObject(lead) ? lead : {};
  const fetchResults = isPlainObject(safeLead.fetchResults) ? safeLead.fetchResults : {};
  const rawData = isPlainObject(fetchResults.rawData)
    ? fetchResults.rawData
    : isPlainObject(fetchResults.actorData)
      ? fetchResults.actorData
      : {};
  const targetUrl = firstDefined(
    safeLead['Lead Proof URL'],
    safeLead['Proof URL'],
    safeLead.Link,
    rawData.requestedPostUrl,
    fetchResults.postUrl,
    rawData.postUrl
  );
  const scrapeReference = firstDefined(rawData.scrapedAt, fetchResults.scrapedAt, evaluatedAt.toISOString());
  const trust = explicitTimestampTrust(rawData);
  const groupFeedUntrusted = isUntrustedGroupFeedUrl(targetUrl) && !trust.explicitlyTrusted;
  const targetMissing = !parseUrl(targetUrl) && !trust.explicitlyTrusted;

  const specs = [];
  const scrapedIso = firstDefined(rawData.posted_at_iso, fetchResults.posted_at_iso);
  const scrapedRaw = firstDefined(rawData.posted_at_raw, fetchResults.posted_at_raw);
  const scrapedPostDate = firstDefined(rawData.postDate, fetchResults.postDate);
  const leadPostingDate = firstDefined(
    safeLead['Lead Posting Date'],
    safeLead['Proof Date'],
    safeLead['Post Date']
  );
  const companionEvidence = [
    ['scraper_raw', scrapedRaw],
    ['scraper_post_date', scrapedPostDate]
  ]
    .filter(([, value]) => value !== undefined)
    .filter(([, value], index, entries) => entries.findIndex(([, other]) => other === value) === index)
    .map(([id, value]) => ({
      id,
      value,
      parsed: parseDateEvidence(value, {
        dateOrder: 'DMY',
        referenceTime: scrapeReference
      })
    }));
  const estimatedCompanion = companionEvidence.find(item =>
    item.parsed.valid && item.parsed.precision !== 'instant'
  );
  const companionIndicatesEstimate = Boolean(estimatedCompanion);
  const companionHasInvalidValue = companionEvidence.some(item => !item.parsed.valid);

  if (scrapedIso !== undefined) {
    specs.push({
      id: 'scraper_iso',
      label: 'Scraped ISO timestamp',
      value: scrapedIso,
      sourceType: 'scraper',
      provenance: trust.method || 'apify.posted_at_iso',
      confidence: 95,
      dateOrder: 'DMY'
    });
  }
  if (scrapedRaw !== undefined) {
    specs.push({
      id: 'scraper_raw',
      label: 'Scraped raw timestamp',
      value: scrapedRaw,
      sourceType: 'scraper',
      provenance: trust.method || 'apify.posted_at_raw',
      confidence: 78,
      dateOrder: 'DMY'
    });
  }
  if (scrapedPostDate !== undefined && scrapedPostDate !== scrapedRaw) {
    specs.push({
      id: 'scraper_post_date',
      label: 'Scraped post date',
      value: scrapedPostDate,
      sourceType: 'scraper',
      provenance: trust.method || 'apify.postDate',
      confidence: 72,
      dateOrder: 'DMY'
    });
  }
  if (leadPostingDate !== undefined) {
    specs.push({
      id: 'lead_posting_date',
      label: 'Lead Posting Date',
      value: leadPostingDate,
      sourceType: 'lead',
      provenance: `lead_input.${leadDateOrder === 'DMY' ? 'dmy' : 'mdy'}`,
      confidence: 65,
      dateOrder: leadDateOrder
    });
  }

  if (!specs.some(spec => spec.sourceType === 'scraper')) {
    const pageActivityDate = firstDefined(rawData?.activity?.latestPostDate, rawData.latestPostDate);
    if (pageActivityDate !== undefined) {
      specs.push({
        id: 'page_activity_date',
        label: 'Latest page activity date',
        value: pageActivityDate,
        sourceType: 'scraper',
        provenance: 'apify.page_activity_not_target_post',
        confidence: 45,
        dateOrder: 'DMY',
        forceUntrusted: true
      });
    }
  }

  const candidates = specs.map(spec => {
    let parsed = parseDateEvidence(spec.value, {
      dateOrder: spec.dateOrder,
      referenceTime: scrapeReference
    });
    if (spec.id === 'scraper_iso' && parsed.valid && estimatedCompanion) {
      parsed = {
        ...parsed,
        rangeStart: estimatedCompanion.parsed.rangeStart,
        rangeEnd: estimatedCompanion.parsed.rangeEnd,
        precision: estimatedCompanion.parsed.precision,
        parser: `iso-derived-from-${estimatedCompanion.parsed.parser}`
      };
    }
    const scraperUntrusted = spec.sourceType === 'scraper' && (
      spec.forceUntrusted || !trust.explicitlyTrusted || trust.explicitlyUntrusted ||
      groupFeedUntrusted || targetMissing
    );
    const actorConfidenceCap = trust.actorConfidence === 'high'
      ? 95
      : trust.actorConfidence === 'medium'
        ? 80
        : trust.actorConfidence === 'low'
          ? 35
          : 70;
    const evidenceConfidence = spec.sourceType === 'scraper'
      ? Math.min(spec.confidence, actorConfidenceCap)
      : spec.confidence;
    const exactMachineEvidence = spec.id === 'scraper_iso' &&
      trust.actorConfidence === 'high' &&
      trust.actorPrecision === 'exact' &&
      trust.actorEstimated === false &&
      !companionIndicatesEstimate &&
      !companionHasInvalidValue &&
      trust.explicitlyTrusted &&
      parsed.precision === 'instant' &&
      parsed.parser === 'iso';
    return {
      ...spec,
      ...parsed,
      trusted: spec.sourceType === 'lead' || !scraperUntrusted,
      confidence: scraperUntrusted ? Math.min(evidenceConfidence, 35) : evidenceConfidence,
      decisionGrade: exactMachineEvidence && !scraperUntrusted,
      estimated: spec.sourceType === 'scraper'
        ? trust.actorEstimated !== false || companionIndicatesEstimate || !exactMachineEvidence
        : true
    };
  });

  const thresholdMs = thresholdHours * HOUR_MS;
  const futureSkewMs = futureSkewMinutes * MINUTE_MS;
  const nowMs = evaluatedAt.getTime();
  for (const candidate of candidates) {
    const classification = classifyCandidate(candidate, nowMs, thresholdMs, futureSkewMs);
    candidate.classification = classification.state;
    candidate.classificationData = classification;
  }

  const warnings = [];
  for (const candidate of candidates.filter(item => !item.valid)) {
    warnings.push(warning(
      'INVALID_DATE_CANDIDATE',
      `${candidate.label} could not be parsed safely.`,
      [candidate.id]
    ));
  }

  const validCandidates = candidates.filter(item => item.valid);
  const invalidScraperCandidates = candidates.filter(
    item => item.sourceType === 'scraper' && !item.valid
  );
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < validCandidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < validCandidates.length; rightIndex += 1) {
      const left = validCandidates[leftIndex];
      const right = validCandidates[rightIndex];
      const gapHours = intervalGapHours(left, right);
      const stateConflict = new Set([left.classification, right.classification]).has('fresh') &&
        new Set([left.classification, right.classification]).has('stale');
      if (gapHours > conflictToleranceHours || stateConflict) {
        conflicts.push({ sources: [left.id, right.id], gapHours: Number(gapHours.toFixed(2)) });
      }
    }
  }
  if (conflicts.length) {
    warnings.push(warning(
      'DATE_SOURCE_CONFLICT',
      'Post date sources disagree materially; freshness was not auto-decided.',
      [...new Set(conflicts.flatMap(conflict => conflict.sources))]
    ));
  }

  const untrustedCandidates = validCandidates.filter(
    candidate => candidate.sourceType === 'scraper' && !candidate.trusted
  );
  if (untrustedCandidates.length) {
    warnings.push(warning(
      'UNTRUSTED_SCRAPER_PROVENANCE',
      groupFeedUntrusted
        ? 'The group-feed scraper timestamp was not tied to the requested permalink.'
        : 'The scraper did not verify that the timestamp belongs to the target post.',
      untrustedCandidates.map(candidate => candidate.id)
    ));
  }

  const futureCandidates = validCandidates.filter(candidate => candidate.classification === 'future');
  if (futureCandidates.length) {
    warnings.push(warning(
      'FUTURE_TIMESTAMP',
      `A post timestamp is more than ${futureSkewMinutes} minutes in the future.`,
      futureCandidates.map(candidate => candidate.id)
    ));
  }

  const skewCandidates = validCandidates.filter(candidate => candidate.classificationData?.futureSkew);
  if (skewCandidates.length) {
    warnings.push(warning(
      'FUTURE_CLOCK_SKEW',
      `A small future timestamp was clamped within the ${futureSkewMinutes}-minute clock-skew allowance.`,
      skewCandidates.map(candidate => candidate.id)
    ));
  }

  const rankedCandidates = [...validCandidates]
    .filter(candidate => candidate.classification !== 'future')
    .sort((left, right) => {
      const score = candidate => candidate.confidence +
        (candidate.trusted ? 20 : 0) +
        (candidate.precision === 'instant' ? 20 : candidate.precision === 'relative' ? 10 : 0);
      return score(right) - score(left);
    });
  const selected = rankedCandidates[0] || null;

  let reasonCode;
  if (conflicts.length) reasonCode = 'DATE_CONFLICT';
  else if (untrustedCandidates.length) reasonCode = 'UNTRUSTED_PROVENANCE';
  else if (futureCandidates.length) reasonCode = 'FUTURE_TIMESTAMP';
  else if (!validCandidates.length) reasonCode = candidates.length ? 'INVALID_DATE' : 'NO_DATE';
  else if (invalidScraperCandidates.length) reasonCode = 'INVALID_DATE';
  else if (selected?.classification === 'indeterminate') reasonCode = 'IMPRECISE_DATE';
  else if (selected?.classification === 'fresh') reasonCode = 'FRESH';
  else if (selected?.classification === 'stale' && selected.decisionGrade) reasonCode = 'STALE';
  else reasonCode = 'ESTIMATED_TIMESTAMP';

  const requiresManualReview = !['FRESH', 'STALE'].includes(reasonCode);
  const decision = requiresManualReview
    ? 'manual_review'
    : reasonCode === 'STALE'
      ? 'stale'
      : 'fresh';
  const autoRejectEligible = decision === 'stale' && selected?.trusted === true &&
    selected.precision === 'instant' && selected.confidence >= 85 &&
    selected.decisionGrade === true;

  let confidenceScore = selected?.confidence || 0;
  const rationale = [];
  if (selected) rationale.push(`Selected ${selected.label} (${selected.provenance}).`);
  if (conflicts.length) {
    confidenceScore = Math.min(confidenceScore, 20);
    rationale.push('Materially conflicting timestamp sources prevent a reliable decision.');
  }
  if (untrustedCandidates.length) {
    confidenceScore = Math.min(confidenceScore, 30);
    rationale.push('Scraped evidence is not proven to belong to the target post.');
  }
  if (futureCandidates.length) {
    confidenceScore = Math.min(confidenceScore, 25);
    rationale.push('Future-dated evidence exceeds the clock-skew allowance.');
  }
  if (selected?.precision === 'day') {
    confidenceScore -= 10;
    rationale.push('The selected evidence supplies a calendar date but no exact time.');
  }
  if (skewCandidates.length) {
    confidenceScore -= 10;
    rationale.push('A small clock-skew correction was applied.');
  }
  confidenceScore = clamp(Math.round(confidenceScore), 0, 100);

  const resolved = !requiresManualReview && Boolean(selected);
  const ageHours = resolved ? selected.classificationData?.ageHours ?? null : null;
  const daysOld = ageHours === null ? null : Math.floor(ageHours / 24);
  const source = selected
    ? { ...candidatePublicView(selected), resolved }
    : null;

  return {
    isFresh: decision === 'fresh' ? true : decision === 'stale' ? false : null,
    daysOld,
    postAgeHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    ageRangeHours: selected &&
      Number.isFinite(selected.classificationData?.ageHoursMin) &&
      Number.isFinite(selected.classificationData?.ageHoursMax)
      ? {
          min: Number(selected.classificationData.ageHoursMin.toFixed(2)),
          max: Number(selected.classificationData.ageHoursMax.toFixed(2))
        }
      : null,
    timestamp: resolved ? selected.normalizedTimestamp : null,
    status: buildStatus(reasonCode, selected?.classification, ageHours || 0),
    scrapedData: validCandidates.some(candidate => candidate.sourceType === 'scraper'),
    decision,
    autoRejectEligible,
    requiresManualReview,
    reasonCode,
    manualReviewReason: requiresManualReview ? describeManualReview(reasonCode) : null,
    thresholdHours,
    evaluatedAt: evaluatedAt.toISOString(),
    warnings,
    source,
    confidence: {
      level: confidenceLevel(confidenceScore),
      score: confidenceScore,
      rationale
    },
    candidates: candidates.map(candidatePublicView),
    hasConflict: conflicts.length > 0,
    conflicts
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function staleAgeText(freshness) {
  const hours = freshness.postAgeHours || 0;
  if (hours < 48) return '1 day old';
  const days = Math.max(1, Math.floor(hours / 24));
  return `${pluralize(days, 'day')} old`;
}

/** Apply the deterministic freshness safety policy to an AI assessment. */
export function applyFreshnessPolicy(aiResponse, freshness) {
  const response = isPlainObject(aiResponse) ? aiResponse : {};
  const reasoning = typeof response.reasoning === 'string'
    ? response.reasoning
    : 'No AI reasoning was supplied.';
  const redFlags = normalizeStringArray(response.red_flags);

  // Revised spec: "Freshness is a priority signal, not an automatic eligibility gate."
  // Age used to overwrite the model's verdict with BAD here, which meant a genuine
  // new-premises event more than the threshold old was rejected before any human or
  // downstream rule could see it. The age is now surfaced as a red flag for
  // prioritisation and the verdict is left to the evidence.
  if (freshness.autoRejectEligible) {
    return {
      ...response,
      reasoning: `[LOW PRIORITY: post is ${staleAgeText(freshness)}, beyond the ${freshness.thresholdHours}-hour priority window] ${reasoning}`,
      red_flags: [...redFlags, `Lead is ${staleAgeText(freshness)} - outside the freshness priority window`],
      needs_manual_review: false
    };
  }

  if (freshness.requiresManualReview) {
    const reviewReason = freshness.manualReviewReason || 'Freshness could not be determined safely.';
    const warningMessages = freshness.warnings.map(item => item.message);
    return {
      ...response,
      verdict: 'UNCLEAR',
      reasoning: `[MANUAL REVIEW REQUIRED: ${reviewReason}] ${reasoning}`,
      red_flags: [...new Set([...redFlags, ...warningMessages])],
      needs_manual_review: true
    };
  }

  return {
    ...response,
    reasoning,
    red_flags: redFlags,
    needs_manual_review: false
  };
}
