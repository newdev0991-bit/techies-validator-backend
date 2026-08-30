export class ProviderError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

export class Providers {
  constructor(config, { token = process.env.APIFY_API_TOKEN, validatorToken = process.env.COT_PIPELINE_API_KEY, fetchFn = fetch } = {}) {
    this.c = config; this.token = token; this.validatorToken = validatorToken; this.fetch = fetchFn;
  }
  async request(url, { method = 'GET', body, token, timeout = 30000, optional404 = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await this.fetch(url, { method, redirect: 'error', signal: controller.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? {'Content-Type':'application/json'} : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (res.status === 404 && optional404) return null;
      // Bound response memory. Never expose provider response text or request URLs in errors.
      let size = 0; const chunks = [];
      if (res.body) for await (const part of res.body) {
        size += part.length;
        if (size > 20 * 1024 * 1024) { controller.abort(); throw new ProviderError('RESPONSE_TOO_LARGE', res.status); }
        chunks.push(Buffer.from(part));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProviderError('INVALID_PROVIDER_JSON', res.status); }
      if (!res.ok) {
        const safeCodes = ['actor_partial_batch','actor_row_failure','apify_unavailable','session_blocked'];
        throw new ProviderError(safeCodes.includes(data?.error?.code) ? data.error.code : `PROVIDER_HTTP_${res.status}`, res.status);
      }
      return data;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('PROVIDER_CONNECTION_UNCERTAIN');
    } finally { clearTimeout(timer); }
  }
  apify(route, options = {}) {
    if (!this.token) throw new ProviderError('APIFY_TOKEN_MISSING');
    return this.request(`https://api.apify.com/v2/${route}`, { ...options, token: this.token });
  }
  async preflight() {
    if (!this.token) throw new ProviderError('APIFY_TOKEN_MISSING');
    if (!this.validatorToken) throw new ProviderError('VALIDATOR_TOKEN_MISSING');
    const caps = await this.request(`${this.c.validatorBaseUrl.replace(/\/$/,'')}/pipeline-capabilities`, { token: this.validatorToken });
    if (caps?.contactEnrichment !== 'cot-contact-enrichment-v1' || caps?.batchContract !== 'cot-data-batch-v1'
        || caps.maxBatchSize < this.c.validationBatchSize
        || !Number.isFinite(caps.actorMaxChargeUsd) || caps.actorMaxChargeUsd <= 0
        || caps.actorMaxChargeUsd > this.c.maxValidationActorChargeUsd) throw new ProviderError('VALIDATOR_NOT_READY');
    const actor = (await this.apify(`actors/${this.c.actorId}`))?.data;
    if (actor?.id !== this.c.actorId) throw new ProviderError('ACTOR_ID_MISMATCH');
    return caps;
  }
  async start(input) {
    const params = new URLSearchParams({ ...this.c.searchRun, waitForFinish: 0, restartOnError: false });
    return (await this.apify(`actors/${this.c.actorId}/runs?${params}`, { method: 'POST', body: input }))?.data;
  }
  async run(id) { return (await this.apify(`actor-runs/${encodeURIComponent(id)}`))?.data; }
  async summary(kv) { return kv ? this.apify(`key-value-stores/${encodeURIComponent(kv)}/records/RUN-SUMMARY`, { optional404: true }) : null; }
  async input(kv) { return this.apify(`key-value-stores/${encodeURIComponent(kv)}/records/INPUT`); }
  async dataset(id) { return (await this.apify(`datasets/${encodeURIComponent(id)}`))?.data; }
  async items(id, offset, limit) { return this.apify(`datasets/${encodeURIComponent(id)}/items?format=json&offset=${offset}&limit=${limit}&clean=false`); }
  validate(payload) {
    return this.request(`${this.c.validatorBaseUrl.replace(/\/$/,'')}/pipeline/validate-batch`, {
      method: 'POST', body: payload, token: this.validatorToken, timeout: this.c.validationTimeoutSeconds * 1000
    });
  }
}
