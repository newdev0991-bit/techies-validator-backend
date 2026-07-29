import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCardDataResponse,
  canonicalizeFacebookUrl,
  normalizeLead
} from '../src/card-data.js';

const NOW = new Date('2026-07-28T00:00:00.000Z');
const lead = {
  Name: 'Example Roofing Ltd',
  Category: 'Roofing',
  Link: 'https://www.facebook.com/example-roofing',
  Address: '12 High Street, Liverpool',
  Country: 'United Kingdom',
  ZIP: 'L1 1AA'
};

function actorData(overrides = {}) {
  return {
    schemaVersion: 'card-data-v1',
    status: 'success',
    pageName: 'Example Roofing',
    canonicalUrl: 'https://www.facebook.com/example-roofing',
    contact: { phone: '0151 123 4567', email: 'hello@example.co.uk' },
    activity: {
      latestPostDate: '2026-06-01T10:00:00.000Z',
      latestPostUrl: 'https://www.facebook.com/example-roofing/posts/123',
      latestPostText: 'Recent roof repair completed.',
      recentPosts: []
    },
    business: {
      tradingStatus: 'active',
      isChain: false,
      isFranchise: false,
      isLargeBusiness: false
    },
    scrape: { success: true, partial: false, blocked: false },
    ...overrides
  };
}

test('normalizes both Card-data and legacy COT columns', () => {
  assert.deepEqual(normalizeLead(lead), {
    name: 'Example Roofing Ltd',
    category: 'Roofing',
    link: 'https://www.facebook.com/example-roofing',
    address: '12 High Street, Liverpool',
    country: 'United Kingdom',
    zip: 'L1 1AA',
    phone: '',
    ownerName: '',
    email: '',
    comment: '',
    passFail: ''
  });

  assert.equal(
    normalizeLead({ 'Company Name': 'Legacy Ltd', 'Lead Proof URL': 'https://facebook.com/legacy' }).name,
    'Legacy Ltd'
  );
});

test('canonicalizes Facebook comment URLs to the post URL', () => {
  assert.equal(
    canonicalizeFacebookUrl(
      'https://www.facebook.com/example/posts/123?comment_id=9&reply_comment_id=10&__tn__=R'
    ),
    'https://www.facebook.com/example/posts/123'
  );
});

test('passes an active independent business inside the six-month window', () => {
  const response = buildCardDataResponse(lead, actorData(), { now: NOW });
  assert.equal(response.validation.verdict, 'PASS');
  assert.equal(response.validation.reasonCode, 'ACTIVE_TRADING_BUSINESS');
  assert.equal(response.lead.passFail, 'PASS');
  assert.equal(response.lead.phone, '0151 123 4567');
});

test('fails activity older than six months', () => {
  const response = buildCardDataResponse(
    lead,
    actorData({
      activity: {
        latestPostDate: '2025-12-01T10:00:00.000Z',
        latestPostUrl: 'https://www.facebook.com/example-roofing/posts/old',
        recentPosts: []
      }
    }),
    { now: NOW }
  );
  assert.equal(response.validation.verdict, 'FAIL');
  assert.equal(response.validation.reasonCode, 'NO_ACTIVITY_WITHIN_SIX_MONTHS');
});

test('fails an explicit franchise even with recent activity', () => {
  const response = buildCardDataResponse(
    lead,
    actorData({
      business: {
        tradingStatus: 'active',
        isChain: false,
        isFranchise: true,
        isLargeBusiness: false,
        chainSignals: ['Franchise opportunities']
      }
    }),
    { now: NOW }
  );
  assert.equal(response.validation.verdict, 'FAIL');
  assert.equal(response.validation.reasonCode, 'LARGE_CHAIN_OR_FRANCHISE');
});

test('sends blocked pages to manual review', () => {
  const response = buildCardDataResponse(
    lead,
    actorData({
      status: 'error',
      scrape: { success: false, partial: false, blocked: true, loginRequired: true }
    }),
    { now: NOW }
  );
  assert.equal(response.validation.verdict, 'MANUAL_REVIEW');
  assert.equal(response.validation.reasonCode, 'SCRAPE_BLOCKED');
});

test('fails a known duplicate identifier', () => {
  const first = buildCardDataResponse(lead, actorData(), { now: NOW });
  const duplicate = buildCardDataResponse(lead, actorData(), {
    now: NOW,
    knownDuplicateKeys: [first.evidence.duplicateKey]
  });
  assert.equal(duplicate.validation.verdict, 'FAIL');
  assert.equal(duplicate.validation.reasonCode, 'DUPLICATE_BUSINESS');
});

test('uses the newest valid page activity and ignores invalid legacy dates', () => {
  const response = buildCardDataResponse(
    lead,
    {
      status: 'success',
      pageName: 'Example Roofing',
      postUrl: 'https://facebook.com/example-roofing/posts/target',
      posted_at_iso: 'not-a-date',
      previousPosts: [
        {
          postUrl: 'https://facebook.com/example-roofing/posts/456?comment_id=8',
          posted_at_iso: '2026-07-20T12:00:00.000Z',
          postText: 'A recent job'
        }
      ],
      scrape: { success: true }
    },
    { now: NOW }
  );
  assert.equal(response.validation.verdict, 'PASS');
  assert.equal(response.evidence.latestPostDate, '2026-07-20T12:00:00.000Z');
  assert.equal(response.evidence.postsChecked, 2);
});
