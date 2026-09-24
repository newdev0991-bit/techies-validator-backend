// Shadow mode (spec §8, plan task 14): run v2 beside v1 on the same lead and
// record both decisions WITHOUT letting v2 affect delivery. Off unless
// VALIDATOR_V2_SHADOW=on. Any v2 failure is swallowed: shadow must never fail
// or slow a production lead beyond V2_SHADOW_TIMEOUT_MS.
import { appendFile } from 'node:fs/promises';
import { validateLeadV2 } from './validate.js';

const on = v => /^(?:on|true|1|yes)$/i.test(String(v || ''));

export function shadowEnabled(env = process.env) {
  return on(env.VALIDATOR_V2_SHADOW);
}

export function shadowRecord(lead, v1, v2) {
  return {
    at: new Date().toISOString(),
    leadKey: lead?.['Search Post ID'] || lead?.['Lead Proof URL'] || lead?.['Company Name'] || null,
    company: lead?.['Company Name'] || null,
    v1: { verdict: v1?.verdict ?? null, needs_manual_review: v1?.needs_manual_review ?? null,
      quality_verdict: v1?.quality_assessment?.verdict ?? null },
    v2: v2 && { verdict: v2.verdict, statuses: v2.statuses, stage1: v2.stage1?.decision,
      stage1_reasons: v2.stage1?.reasons, event: v2.stage2?.classification?.event_type ?? null,
      decidedBy: v2.stage2?.decidedBy ?? null, costUsd: v2.costUsd, next_step: v2.next_step },
    caption: String(lead?.fetchResults?.rawData?.postText || '').slice(0, 500)
  };
}

export async function attachShadowV2(lead, v1, { env = process.env, run = validateLeadV2 } = {}) {
  if (!shadowEnabled(env)) return v1;
  const timeoutMs = Number(env.V2_SHADOW_TIMEOUT_MS) || 40_000;
  let v2 = null;
  let timer;
  try {
    v2 = await Promise.race([
      run(lead, { freshness: v1?.freshness }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
  } catch (error) {
    console.warn(`[shadow-v2] failed: ${error?.name || 'Error'}`);
  } finally {
    clearTimeout(timer);
  }
  const record = shadowRecord(lead, v1, v2);
  // One JSON line per lead in Render logs; `scripts/v2-compare-shadow.mjs` reads them.
  console.log(`[shadow-v2] ${JSON.stringify(record)}`);
  if (env.V2_SHADOW_LOG_PATH) {
    appendFile(env.V2_SHADOW_LOG_PATH, `${JSON.stringify(record)}\n`).catch(() => {});
  }
  // Attached for inspection; delivery code reads only v1 fields.
  return v2 ? { ...v1, shadow_v2: v2 } : v1;
}
