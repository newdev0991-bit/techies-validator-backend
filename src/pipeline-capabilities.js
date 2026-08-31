import { timingSafeEqual } from 'node:crypto';

export function pipelineActorOptions(env = process.env) {
  const cap = Number(env.COT_ACTOR_MAX_CHARGE_USD);
  return Number.isFinite(cap) && cap > 0 && cap <= 5
    ? { maxTotalChargeUsd: cap, timeout: 300, restartOnError: false } : null;
}

export function cotActorPhaseOptions(phase, env = process.env) {
  const total = pipelineActorOptions(env);
  // Never introduce a second unbounded paid call when the total cap is absent.
  if (!total) throw new Error('COT_ACTOR_MAX_CHARGE_USD is required for strict contact lookup');
  return { ...total, maxTotalChargeUsd: total.maxTotalChargeUsd / 2,
    timeout: phase === 'contacts' ? 180 : 120 };
}

export function pipelineAccess(req, res, next) {
  const expected = process.env.COT_PIPELINE_API_KEY;
  const supplied = req.get('Authorization') || '';
  const a = Buffer.from(supplied), b = Buffer.from(`Bearer ${expected || ''}`);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: { code: 'PIPELINE_UNAUTHORIZED' } });
  }
  if (!pipelineActorOptions() || process.env.COT_CONTACT_ACTOR_READY !== 'true') {
    return res.status(503).json({ error: { code: 'PIPELINE_NOT_CONFIGURED' } });
  }
  next();
}
