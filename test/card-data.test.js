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
  const response = buildCardDataResponse(lead, actorData(), {
    now: NOW,
    processingTimeMs: 1250
  });
  assert.equal(response.validation.verdict, 'PASS');
  assert.equal(response.validation.reasonCode, 'ACTIVE_TRADING_BUSINESS');
  assert.equal(response.lead.passFail, 'PASS');
  assert.equal(response.lead.phone, '0151 123 4567');
  assert.match(response.analysis.summary, /active, independent business/i);
  assert.equal(response.analysis.processingTimeMs, 1250);
  assert.ok(response.analysis.confidence >= 0 && response.analysis.confidence <= 100);
  assert.ok(response.analysis.opportunityScore >= 0 && response.analysis.opportunityScore <= 100);
  assert.ok(response.analysis.successFactors.some((factor) => /recent facebook activity/i.test(factor)));
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
  assert.ok(response.analysis.riskFactors.some((factor) => /acceptance window/i.test(factor)));
  assert.match(response.analysis.recommendedAction, /do not progress/i);
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
  assert.ok(response.analysis.riskFactors.some((factor) => /blocked/i.test(factor)));
  assert.match(response.analysis.recommendedAction, /manually/i);
});

test('rejects unverified account-level email and sends an uncertain page identity to review', () => {
  const response = buildCardDataResponse(
    {
      ...lead,
      Name: 'Heritage Roofing & Co',
      Link: 'https://www.facebook.com/686561021206649'
    },
    actorData({
      pageName: 'Unrelated Personal Profile',
      canonicalUrl: 'https://www.facebook.com/686561021206649',
      email: 'signed-in-account@example.test',
      contact: { email: 'signed-in-account@example.test' },
      evidence: {
        activityUrls: ['https://www.facebook.com/686561021206649/posts/123'],
        contactSourceUrls: [
          'https://www.facebook.com/686561021206649?sk=about_contact_and_basic_info'
        ]
      }
    }),
    { now: NOW }
  );

  assert.equal(response.validation.verdict, 'MANUAL_REVIEW');
  assert.equal(response.validation.reasonCode, 'BUSINESS_IDENTITY_UNCONFIRMED');
  assert.equal(response.lead.email, '');
  assert.equal(response.evidence.contact.email, null);
  assert.equal(response.evidence.contact.emailVerified, false);
  assert.equal(response.evidence.contact.emailSource, 'rejected-unconfirmed-identity');
});

test('accepts an email only when the page contact extractor verifies its provenance', () => {
  const response = buildCardDataResponse(
    lead,
    actorData({
      contact: {
        phone: '0151 123 4567',
        email: 'hello@example.co.uk',
        emailVerified: true,
        emailSource: 'mailto-link'
      }
    }),
    { now: NOW }
  );

  assert.equal(response.validation.verdict, 'PASS');
  assert.equal(response.lead.email, 'hello@example.co.uk');
  assert.equal(response.evidence.contact.emailVerified, true);
  assert.equal(response.evidence.contact.emailSource, 'mailto-link');
});

test('rejects a labeled account email until the Facebook page identity is matched', () => {
  const response = buildCardDataResponse(
    {
      ...lead,
      Name: 'City Roofing & Landscaping',
      Link: 'https://www.facebook.com/109181487628958'
    },
    actorData({
      pageName: 'Hernández Kaito',
      canonicalUrl: 'https://www.facebook.com/109181487628958',
      contact: {
        phone: '07700 900123',
        email: 'jehusedillo1@yahoo.com',
        emailVerified: true,
        emailSource: 'labeled-page-contact',
        website: 'https://unrelated.example.test'
      },
      business: {
        tradingStatus: 'active',
        isChain: false,
        isFranchise: false,
        isLargeBusiness: false,
        identityStatus: 'unconfirmed',
        identityConfidence: 'low'
      }
    }),
    { now: NOW }
  );

  assert.equal(response.validation.verdict, 'MANUAL_REVIEW');
  assert.equal(response.validation.reasonCode, 'BUSINESS_IDENTITY_UNCONFIRMED');
  assert.equal(response.lead.email, '');
  assert.equal(response.lead.phone, '');
  assert.equal(response.evidence.contact.email, null);
  assert.equal(response.evidence.contact.emailVerified, false);
  assert.equal(response.evidence.contact.emailSource, 'rejected-unconfirmed-identity');
  assert.equal(response.evidence.contact.phone, null);
  assert.equal(response.evidence.contact.website, null);
  assert.ok(
    !response.analysis.successFactors.some((factor) => /email|contact detail/i.test(factor))
  );
});

test('accepts missing contacts from a Google-matched official business website', () => {
  const response = buildCardDataResponse(
    {
      ...lead,
      Name: 'Cheshire Roofing',
      Address: '60 High Street, Macclesfield',
      ZIP: 'SK11 8BR'
    },
    actorData({
      pageName: 'Unconfirmed Facebook Account',
      contact: {
        phone: '01625 123456',
        phoneVerified: true,
        phoneSource: 'google-official-website-tel',
        email: 'hello@cheshireroofing.example',
        emailVerified: true,
        emailSource: 'google-official-website-mailto',
        website: 'https://cheshireroofing.example',
        source: 'google-official-website',
        sourceUrl: 'https://cheshireroofing.example/contact',
        identityStatus: 'matched',
        identityConfidence: 'high',
        searchQuery: '"Cheshire Roofing" "SK11 8BR" contact'
      },
      business: {
        tradingStatus: 'active',
        isChain: false,
        isFranchise: false,
        isLargeBusiness: false,
        identityStatus: 'unconfirmed',
        identityConfidence: 'low'
      }
    }),
    { now: NOW }
  );

  assert.equal(response.validation.verdict, 'MANUAL_REVIEW');
  assert.equal(response.validation.reasonCode, 'BUSINESS_IDENTITY_UNCONFIRMED');
  assert.equal(response.lead.phone, '01625 123456');
  assert.equal(response.lead.email, 'hello@cheshireroofing.example');
  assert.equal(response.evidence.contact.source, 'google-official-website');
  assert.equal(response.evidence.contact.identityStatus, 'matched');
  assert.equal(response.evidence.contact.phoneVerified, true);
  assert.equal(
    response.evidence.contact.emailSource,
    'google-official-website-mailto'
  );
  assert.ok(
    response.analysis.successFactors.some((factor) => /google verified/i.test(factor))
  );
});

test('accepts a phone from a Google-matched business listing, labelled as a listing', () => {
  const response = buildCardDataResponse(
    {
      ...lead,
      Name: 'Cheshire Roofing',
      Address: '60 High Street, Macclesfield',
      ZIP: 'SK11 8BR'
    },
    actorData({
      pageName: 'Unconfirmed Facebook Account',
      contact: {
        phone: '01625 123456',
        phoneVerified: true,
        phoneSource: 'google-directory-listing-tel',
        website: 'https://www.yell.com/biz/cheshire-roofing-macclesfield-1234',
        source: 'google-directory-listing',
        sourceUrl: 'https://www.yell.com/biz/cheshire-roofing-macclesfield-1234',
        identityStatus: 'matched',
        locationMatch: 'town',
        searchQuery: '"Cheshire Roofing" macclesfield'
      },
      business: {
        tradingStatus: 'active',
        isChain: false,
        isFranchise: false,
        isLargeBusiness: false,
        identityStatus: 'unconfirmed',
        identityConfidence: 'low'
      }
    }),
    { now: NOW }
  );

  // The whole point of the change: this phone used to be discarded here.
  assert.equal(response.lead.phone, '01625 123456');
  assert.equal(response.evidence.contact.phoneVerified, true);
  assert.equal(response.evidence.contact.source, 'google-directory-listing');
  assert.equal(response.evidence.contact.sourceKind, 'listing');
  assert.equal(response.evidence.contact.locationMatch, 'town');
  // A third-party listing never inherits a first-party site's confidence by default.
  assert.equal(response.evidence.contact.identityConfidence, 'medium');
  assert.ok(
    response.analysis.successFactors.some((factor) => /business listing/i.test(factor)),
    'a listing is described as one rather than as an official website'
  );
  assert.ok(
    !response.analysis.successFactors.some((factor) => /official website/i.test(factor))
  );
});

test('a registry listing is accepted, and an unknown Google source is not', () => {
  const build = (source) => buildCardDataResponse(
    { ...lead, Name: 'Cheshire Roofing', Address: '60 High Street, Macclesfield', ZIP: 'SK11 8BR' },
    actorData({
      pageName: 'Unconfirmed Facebook Account',
      contact: {
        phone: '01625 123456', phoneVerified: true, phoneSource: `${source}-tel`,
        source, sourceUrl: 'https://example.test/record/1234', identityStatus: 'matched'
      },
      business: { tradingStatus: 'active', isChain: false, isFranchise: false,
        isLargeBusiness: false, identityStatus: 'unconfirmed', identityConfidence: 'low' }
    }),
    { now: NOW }
  );

  assert.equal(build('google-registry-listing').lead.phone, '01625 123456');
  // An unrecognised label must never become a callable contact.
  const unknown = build('google-scraped-somewhere');
  assert.equal(unknown.lead.phone, '');
  assert.equal(unknown.evidence.contact.sourceKind, null);
});

test('rejects Google contacts when the official website identity is unconfirmed', () => {
  const response = buildCardDataResponse(
    lead,
    actorData({
      pageName: 'Unconfirmed Facebook Account',
      contact: {
        phone: '07700 900123',
        phoneVerified: true,
        email: 'wrong@example.test',
        emailVerified: true,
        emailSource: 'google-official-website-mailto',
        source: 'google-official-website',
        sourceUrl: 'https://unrelated.example.test',
        identityStatus: 'unconfirmed',
        identityConfidence: 'low'
      },
      business: {
        tradingStatus: 'active',
        isChain: false,
        isFranchise: false,
        isLargeBusiness: false,
        identityStatus: 'unconfirmed',
        identityConfidence: 'low'
      }
    }),
    { now: NOW }
  );

  assert.equal(response.lead.phone, '');
  assert.equal(response.lead.email, '');
  assert.equal(response.evidence.contact.phone, null);
  assert.equal(response.evidence.contact.email, null);
  assert.equal(response.evidence.contact.identityStatus, 'unconfirmed');
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
