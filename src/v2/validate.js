// Validator v2 orchestrator: Stage 1 rules -> Stage 2 event classifier ->
// separate statuses (spec §3). Existing deterministic modules (freshness,
// identity, contacts) are reused unchanged so v1 and v2 share one truth for them.
import { runRules, captionOf, RULES_VERSION } from './rules.js';
import { classifyEvent, CLASSIFIER_VERSION } from './event-classifier.js';
import { evaluateLeadFreshness } from '../freshness.js';
import { evaluateCotIdentity } from '../cot-identity.js';
import { enrichCotContacts } from '../cot-contacts.js';

export const V2_VERSION = `validator-v2 (${RULES_VERSION}, ${CLASSIFIER_VERSION})`;

export function opportunityStatus(rules, stage2) {
  if (rules.decision === 'REJECT') return 'NOT_QUALIFIED';
  if (rules.decision === 'NEEDS_EVIDENCE') return 'UNCERTAIN';
  return { PASS: 'QUALIFIED', FAIL: 'NOT_QUALIFIED' }[stage2?.decision] || 'UNCERTAIN';
}

export function identityStatus(identity, classification) {
  if (identity?.status === 'matched') return 'VERIFIED';
  if (classification?.about === 'third_party') return identity?.requiresManualReview ? 'THIRD_PARTY_UNRESOLVED' : 'THIRD_PARTY_NAMED';
  if (identity?.status === 'not_required' && classification?.about === 'self') return 'VERIFIED';
  return identity?.requiresManualReview ? 'UNRESOLVED' : classification?.about === 'self' ? 'VERIFIED' : 'UNRESOLVED';
}

export function eligibilityStatus(rules) {
  const hard = rules.reasons.filter(r => !r.startsWith('excluded_event') && r !== 'duplicate');
  if (hard.length) return { status: 'INELIGIBLE', reasons: hard };
  if (rules.reasons.includes('duplicate')) return { status: 'INELIGIBLE', reasons: ['duplicate'] };
  return { status: 'ELIGIBLE', reasons: [] };
}

// A direct phone is required for delivery; address alone is not enough.
export function contactStatus(contacts) {
  if (!contacts) return 'UNAVAILABLE';
  if (contacts.status === 'review_required') return 'CONFLICT';
  // cot-contacts marks 'complete' exactly when a usable phone is known.
  if (contacts.status === 'complete') return 'COMPLETE';
  return contacts.status === 'partial' ? 'PHONE_MISSING' : 'UNAVAILABLE';
}

export function deliveryStatus({ opportunity, identity, eligibility, contact, freshness, requireFresh }) {
  if (opportunity === 'NOT_QUALIFIED' || eligibility === 'INELIGIBLE') return 'REJECTED';
  if (opportunity === 'UNCERTAIN' || identity === 'UNRESOLVED' || identity === 'THIRD_PARTY_UNRESOLVED'
      || contact === 'CONFLICT' || freshness?.requiresManualReview) return 'REVIEW';
  if (contact !== 'COMPLETE') return 'NOT_READY';          // goes to contact recovery, not dropped
  if (requireFresh && freshness?.decision !== 'fresh') return 'NOT_READY';
  return 'READY';
}

/** Legacy single verdict so v2 can be compared with v1 and read by old clients. */
export function legacyVerdict(s) {
  if (s.delivery === 'REJECTED') return 'BAD';
  if (s.opportunity === 'QUALIFIED' && s.delivery !== 'REVIEW') return 'GOOD';
  return 'UNCLEAR';
}

export async function validateLeadV2(lead, options = {}) {
  const started = Date.now();
  const rules = runRules(lead);
  const caption = captionOf(lead);
  const stage2 = rules.decision === 'CONTINUE' ? await classifyEvent(caption, rules.facts, options) : null;
  const claim = stage2?.classification ? {
    relationship: stage2.classification.about,
    businessName: stage2.classification.business_name,
    evidenceQuote: stage2.classification.evidence_quote,
    locationQuote: stage2.classification.location_quote
  } : {};
  const freshness = options.freshness ?? evaluateLeadFreshness(lead, { leadDateOrder: options.leadDateOrder });
  const identity = evaluateCotIdentity(lead, claim);
  const contacts = enrichCotContacts(lead, identity);
  // Spec D1 resolved: age gates delivery, not opportunity. Same FRESHNESS_GATE
  // switch as pipeline/records.mjs.
  const requireFresh = options.requireFresh ?? !/^(?:off|false|0|no)$/i.test(String(process.env.FRESHNESS_GATE || ''));

  const statuses = {
    opportunity: opportunityStatus(rules, stage2),
    identity: identityStatus(identity, stage2?.classification),
    eligibility: eligibilityStatus(rules).status,
    contact: contactStatus(contacts),
    freshness: freshness?.decision || 'unknown'
  };
  statuses.delivery = deliveryStatus({ ...statuses, freshness, requireFresh });

  return {
    version: V2_VERSION,
    verdict: legacyVerdict(statuses),
    statuses,
    stage1: { decision: rules.decision, reasons: rules.reasons, facts: rules.facts },
    stage2: stage2 && {
      decision: stage2.decision, decidedBy: stage2.decidedBy, classification: stage2.classification,
      steps: stage2.steps, costUsd: stage2.totalCostUsd
    },
    eligibility_reasons: eligibilityStatus(rules).reasons,
    next_step: statuses.delivery === 'REVIEW' && statuses.opportunity === 'UNCERTAIN' ? 'evidence_recovery'
      : statuses.delivery === 'NOT_READY' && statuses.contact !== 'COMPLETE' ? 'contact_recovery'
      : statuses.delivery === 'REVIEW' ? 'human_review' : null,
    costUsd: stage2?.totalCostUsd || 0,
    latencyMs: Date.now() - started
  };
}
