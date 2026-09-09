import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFreshnessPolicy,
  evaluateLeadFreshness,
  parseDateEvidence
} from '../src/freshness.js';

const DIRECT_POST_URL = 'https://www.facebook.com/example/posts/123';
const GENESIS_GROUP_URL =
  'https://www.facebook.com/groups/689239672413863/?multi_permalinks=1760741248597028&hoisted_section_header_type=recently_seen';

function leadWithTimestamp(timestamp, overrides = {}) {
  return {
    'Company Name': 'Example Ltd',
    'Lead Proof URL': DIRECT_POST_URL,
    fetchResults: {
      rawData: {
        status: 'success',
        scrape: { success: true },
        posted_at_iso: timestamp,
        postUrl: DIRECT_POST_URL,
        time_target_matched: true,
        time_confidence: 'high',
        time_target_match_method: 'direct_post_url',
        time_precision: 'exact',
        time_is_estimated: false,
        ...overrides
      }
    }
  };
}

function aiResponse(overrides = {}) {
  return {
    verdict: 'GOOD',
    reasoning: 'The business appears to be opening.',
    red_flags: [],
    ...overrides
  };
}

test('parses UK numeric and named dates explicitly in Europe/London', () => {
  assert.equal(
    parseDateEvidence('04/08/2026 13:49').normalizedTimestamp,
    '2026-08-04T12:49:00.000Z'
  );
  assert.equal(
    parseDateEvidence('Tuesday, 4 August 2026 at 13:49').normalizedTimestamp,
    '2026-08-04T12:49:00.000Z'
  );
  assert.equal(
    parseDateEvidence('04/08/2026', { dateOrder: 'MDY' }).rangeStart,
    '2026-04-07T23:00:00.000Z'
  );
});

test('does not let JavaScript reinterpret unsupported locale dates', () => {
  const parsed = parseDateEvidence('August-ish 4, 2026');
  assert.equal(parsed.valid, false);
  assert.equal(parsed.errorCode, 'UNSUPPORTED_DATE_FORMAT');
  assert.equal(parseDateEvidence('2026-02-30T00:00:00Z').valid, false);
});

test('rejects nonexistent and ambiguous UK daylight-saving wall times', () => {
  const nonexistent = parseDateEvidence('29/03/2026 01:30');
  assert.equal(nonexistent.valid, false);
  assert.equal(nonexistent.errorCode, 'NONEXISTENT_LOCAL_TIME');

  const ambiguous = parseDateEvidence('25/10/2026 01:30');
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.errorCode, 'AMBIGUOUS_LOCAL_TIME');
});

test('treats exactly 24 hours as fresh', () => {
  const result = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-05T04:00:00.000Z'),
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.isFresh, true);
  assert.equal(result.decision, 'fresh');
  assert.equal(result.postAgeHours, 24);
  assert.equal(result.status, 'Fresh - Posted 24 hours ago');
  assert.equal(result.autoRejectEligible, false);
});

test('treats one millisecond beyond 24 hours as stale and auto-reject eligible', () => {
  const result = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-05T03:59:59.999Z'),
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.isFresh, false);
  assert.equal(result.decision, 'stale');
  assert.equal(result.autoRejectEligible, true);
  assert.equal(result.status, 'Stale - Posted 1 day ago');
});

test('allows only the configured small future clock skew', () => {
  const now = new Date('2026-08-06T04:00:00.000Z');
  const allowed = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-06T04:05:00.000Z'),
    { now, futureSkewMinutes: 5 }
  );
  assert.equal(allowed.decision, 'fresh');
  assert.equal(allowed.postAgeHours, 0);
  assert.ok(allowed.warnings.some(item => item.code === 'FUTURE_CLOCK_SKEW'));

  const rejected = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-06T04:05:00.001Z'),
    { now, futureSkewMinutes: 5 }
  );
  assert.equal(rejected.decision, 'manual_review');
  assert.equal(rejected.reasonCode, 'FUTURE_TIMESTAMP');
  assert.equal(rejected.autoRejectEligible, false);
});

test('date-only evidence crossing the exact boundary requires manual review', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          posted_at_raw: '04/08/2026',
          time_target_matched: true,
          time_confidence: 'medium',
          time_precision: 'date-only',
          time_estimated: true
        }
      }
    },
    { now: new Date('2026-08-05T12:00:00.000Z') }
  );
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.reasonCode, 'IMPRECISE_DATE');
  assert.equal(result.isFresh, null);
});

test('Genesis Cannock conflicting group-feed evidence can never auto-reject', () => {
  const genesis = {
    'Company Name': 'Genesis Cannock',
    'Lead Proof URL': GENESIS_GROUP_URL,
    'Lead Posting Date': '08/06/2026',
    fetchResults: {
      rawData: {
        status: 'success',
        posted_at_iso: '2026-08-04T05:49:00.000Z',
        posted_at_raw: '04/08/2026',
        postDate: '04/08/2026',
        postUrl: GENESIS_GROUP_URL
      }
    }
  };
  const result = evaluateLeadFreshness(genesis, {
    now: new Date('2026-08-06T04:11:34.000Z'),
    leadDateOrder: 'MDY'
  });

  assert.equal(result.decision, 'manual_review');
  assert.equal(result.reasonCode, 'DATE_CONFLICT');
  assert.equal(result.hasConflict, true);
  assert.equal(result.isFresh, null);
  assert.equal(result.timestamp, null);
  assert.equal(result.autoRejectEligible, false);
  assert.equal(result.requiresManualReview, true);
  assert.ok(result.warnings.some(item => item.code === 'DATE_SOURCE_CONFLICT'));
  assert.ok(result.warnings.some(item => item.code === 'UNTRUSTED_SCRAPER_PROVENANCE'));
  assert.deepEqual(
    result.candidates.map(item => item.id),
    ['scraper_iso', 'scraper_raw', 'lead_posting_date']
  );
  assert.equal(
    result.candidates.find(item => item.id === 'lead_posting_date').normalizedTimestamp,
    '2026-08-05T23:00:00.000Z'
  );
  assert.equal(
    result.candidates.find(item => item.id === 'scraper_raw').rangeStart,
    '2026-08-03T23:00:00.000Z'
  );

  const enriched = applyFreshnessPolicy(aiResponse({ verdict: 'BAD' }), result);
  assert.equal(enriched.verdict, 'UNCLEAR');
  assert.equal(enriched.needs_manual_review, true);
  assert.match(enriched.reasoning, /^\[MANUAL REVIEW REQUIRED:/);
  assert.doesNotMatch(enriched.reasoning, /AUTO REJECTED/);
});

test('an unverified group-feed timestamp requires review even when dates align', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': GENESIS_GROUP_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          posted_at_iso: '2026-08-06T01:00:00.000Z'
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.reasonCode, 'UNTRUSTED_PROVENANCE');
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.autoRejectEligible, false);
});

test('medium-confidence actor provenance is trusted but still requires review', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': GENESIS_GROUP_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          posted_at_iso: '2026-08-04T01:00:00.000Z',
          time_target_matched: true,
          time_confidence: 'medium',
          time_target_match_method: 'target_post_modal',
          time_precision: 'exact-instant',
          time_estimated: false,
          target_post_id: '1760741248597028',
          requestedPostUrl: GENESIS_GROUP_URL,
          postUrl: GENESIS_GROUP_URL
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.reasonCode, 'ESTIMATED_TIMESTAMP');
  assert.equal(result.autoRejectEligible, false);
  assert.equal(result.source.trusted, true);
  assert.equal(result.source.confidence, 80);
  assert.equal(result.source.provenance, 'target_post_modal');
});

test('only high-confidence exact machine evidence may auto-reject stale data', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': GENESIS_GROUP_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          posted_at_iso: '2026-08-04T01:00:00.000Z',
          time_target_matched: true,
          time_confidence: 'high',
          time_target_match_method: 'target_post_modal',
          time_precision: 'exact',
          time_is_estimated: false
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.reasonCode, 'STALE');
  assert.equal(result.decision, 'stale');
  assert.equal(result.autoRejectEligible, true);
  assert.equal(result.source.confidence, 95);
});

test('exact machine evidence without an explicit HIGH confidence stays manual', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          posted_at_iso: '2026-08-04T01:00:00.000Z',
          postUrl: DIRECT_POST_URL
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.source.classification, 'stale');
  assert.equal(result.source.confidence, 35);
  assert.equal(result.reasonCode, 'UNTRUSTED_PROVENANCE');
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.autoRejectEligible, false);
});

test('HIGH metadata without successful scrape and target match cannot auto-reject', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          posted_at_iso: '2026-08-04T01:00:00.000Z',
          time_confidence: 'high',
          time_precision: 'exact',
          time_is_estimated: false
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.reasonCode, 'UNTRUSTED_PROVENANCE');
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.autoRejectEligible, false);
  assert.equal(result.source.decisionGrade, false);
});

test('low-confidence actor target matching remains untrusted', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': GENESIS_GROUP_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          posted_at_iso: '2026-08-04T01:00:00.000Z',
          time_target_matched: true,
          time_confidence: 'low',
          time_target_match_method: 'generic_story_scan'
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.reasonCode, 'UNTRUSTED_PROVENANCE');
  assert.equal(result.autoRejectEligible, false);
});

test('a synthesized ISO remains estimated when the companion label is relative', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          scrapedAt: '2026-08-06T04:00:00.000Z',
          posted_at_iso: '2026-08-05T05:00:00.000Z',
          posted_at_raw: '23h',
          time_target_matched: true,
          time_confidence: 'high',
          time_target_match_method: 'relative_label',
          time_precision: 'relative-subday',
          time_estimated: true
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.source.id, 'scraper_iso');
  assert.equal(result.source.classification, 'fresh');
  assert.equal(result.source.decisionGrade, false);
  assert.equal(result.source.estimated, true);
  assert.equal(result.reasonCode, 'FRESH');
  assert.equal(result.decision, 'fresh');
});

test('live Genesis actor aliases resolve target-matched 10h evidence as safely fresh', () => {
  const result = evaluateLeadFreshness(
    {
      'Company Name': 'Genesis Cannock',
      'Lead Proof URL': GENESIS_GROUP_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          scrapedAt: '2026-08-06T04:00:00.000Z',
          posted_at_iso: '2026-08-05T18:00:00.000Z',
          posted_at_raw: '10h',
          time_target_matched: true,
          time_confidence: 'medium',
          time_target_match_method: 'target_permalink_anchor',
          time_precision: 'relative-subday',
          time_estimated: true,
          timestampProvenance: {
            targetPostMatched: true,
            trusted: false,
            method: 'target_permalink_anchor',
            confidence: 'medium',
            precision: 'relative-subday',
            estimated: true
          }
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.reasonCode, 'FRESH');
  assert.equal(result.decision, 'fresh');
  assert.equal(result.isFresh, true);
  assert.equal(result.autoRejectEligible, false);
  assert.equal(result.source.classification, 'fresh');
  assert.equal(result.source.precision, 'relative');
  assert.equal(result.source.estimated, true);
  assert.equal(result.source.trusted, true);
  assert.deepEqual(result.ageRangeHours, { min: 10, max: 11 });
  assert.equal(result.source.ageHoursMin, 10);
  assert.equal(result.source.ageHoursMax, 11);
});

test('invalid or imprecise scraper companions block stale auto-rejection', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          scrapedAt: '2026-08-06T04:00:00.000Z',
          posted_at_iso: '2026-08-04T04:00:00.000Z',
          posted_at_raw: 'not-a-date',
          postDate: '1d',
          time_target_matched: true,
          time_confidence: 'high',
          time_precision: 'exact',
          time_is_estimated: false
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.reasonCode, 'INVALID_DATE');
  assert.equal(result.autoRejectEligible, false);
  assert.ok(result.warnings.some(item => item.code === 'INVALID_DATE_CANDIDATE'));
});

test('same-day lead date can safely mark a non-Facebook lead fresh', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': 'https://www.tiktok.com/@example/video/123',
      'Lead Posting Date': '08/06/2026'
    },
    {
      now: new Date('2026-08-06T04:00:00.000Z'),
      leadDateOrder: 'MDY'
    }
  );
  assert.equal(result.source.id, 'lead_posting_date');
  assert.equal(result.source.classification, 'fresh');
  assert.equal(result.decision, 'fresh');
  assert.equal(result.autoRejectEligible, false);
});

test('missing and invalid dates produce structured manual-review reasons', () => {
  const missing = evaluateLeadFreshness(
    { 'Lead Proof URL': DIRECT_POST_URL },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(missing.reasonCode, 'NO_DATE');
  assert.equal(missing.requiresManualReview, true);

  const invalid = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: { rawData: { posted_at_iso: 'not-a-date' } }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(invalid.reasonCode, 'INVALID_DATE');
  assert.ok(invalid.warnings.some(item => item.code === 'INVALID_DATE_CANDIDATE'));
});

test('an over-threshold post is deprioritised, never rejected on age alone', () => {
  const stale = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-05T03:00:00.000Z'),
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(stale.autoRejectEligible, true);
  const applied = applyFreshnessPolicy(aiResponse(), stale);
  // The whole point of the revised spec: a qualifying premises event stays GOOD even
  // when the post is past the priority window. This used to come back BAD.
  assert.equal(applied.verdict, 'GOOD');
  assert.equal(applied.needs_manual_review, false);
  assert.ok(applied.red_flags.some(flag => /outside the freshness priority window/.test(flag)),
    'the age must still be visible as a prioritisation signal');
});

test('unresolved freshness evidence still routes to manual review', () => {
  const unresolved = evaluateLeadFreshness(
    { 'Lead Proof URL': DIRECT_POST_URL, fetchResults: { rawData: {} } },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(unresolved.requiresManualReview, true);
  const applied = applyFreshnessPolicy(aiResponse(), unresolved);
  // Missing evidence is a statement about the evidence, not the age, so this gate stays.
  assert.equal(applied.verdict, 'UNCLEAR');
  assert.equal(applied.needs_manual_review, true);
});

test('priority age grammar uses correct singular and plural', () => {
  const oneDay = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-05T03:00:00.000Z'),
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  const oneDayResponse = applyFreshnessPolicy(aiResponse(), oneDay);
  assert.match(oneDayResponse.reasoning, /post is 1 day old/);
  assert.doesNotMatch(oneDayResponse.reasoning, /1 days/);

  const twoDays = evaluateLeadFreshness(
    leadWithTimestamp('2026-08-04T03:00:00.000Z'),
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  const twoDayResponse = applyFreshnessPolicy(aiResponse(), twoDays);
  assert.match(twoDayResponse.reasoning, /post is 2 days old/);
});

test('23h relative evidence is safely fresh but never auto-reject eligible', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          scrapedAt: '2026-08-06T04:00:00.000Z',
          posted_at_raw: '23 h',
          time_target_matched: true,
          time_confidence: 'medium',
          time_precision: 'relative-subday',
          time_estimated: true
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.source.classification, 'fresh');
  assert.equal(result.decision, 'fresh');
  assert.equal(result.reasonCode, 'FRESH');
  assert.equal(result.isFresh, true);
  assert.equal(result.source.precision, 'relative');
  assert.equal(result.source.parser, 'facebook-relative');
  const enriched = applyFreshnessPolicy(aiResponse(), result);
  assert.equal(enriched.verdict, 'GOOD');
});

test('1d relative evidence spans the threshold and stays manual', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          scrapedAt: '2026-08-06T04:00:00.000Z',
          posted_at_raw: '1d',
          time_target_matched: true,
          time_confidence: 'medium',
          time_precision: 'relative-day',
          time_estimated: true
        }
      }
    },
    { now: new Date('2026-08-06T04:00:00.000Z') }
  );
  assert.equal(result.source.classification, 'indeterminate');
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.reasonCode, 'IMPRECISE_DATE');
  assert.equal(result.autoRejectEligible, false);
});

test('Yesterday is parsed against the UK scrape date but never treated as exact', () => {
  const result = evaluateLeadFreshness(
    {
      'Lead Proof URL': DIRECT_POST_URL,
      fetchResults: {
        rawData: {
          status: 'success',
          scrape: { success: true },
          scrapedAt: '2026-08-06T12:00:00.000Z',
          posted_at_raw: 'Yesterday',
          time_target_matched: true,
          time_confidence: 'medium',
          time_precision: 'relative-day',
          time_estimated: true
        }
      }
    },
    { now: new Date('2026-08-06T12:00:00.000Z') }
  );
  assert.equal(result.source.parser, 'facebook-yesterday');
  assert.equal(result.source.precision, 'relative');
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.reasonCode, 'IMPRECISE_DATE');
  assert.equal(result.autoRejectEligible, false);
});
