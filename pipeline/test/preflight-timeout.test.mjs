import assert from 'node:assert/strict';
import test from 'node:test';
import { Providers } from '../providers.mjs';

test('preflight allows longer than the default 30s for a cold validator', () => {
  // The validator is a Render service that sleeps when idle; a cold start regularly
  // exceeds 30s. A timeout there raises PROVIDER_CONNECTION_UNCERTAIN, which halts the
  // pipeline permanently. The preflight read is cheap, so it can afford to wait.
  const seen = [];
  const providers = new Providers(
    { validatorBaseUrl: 'https://validator.example', validationBatchSize: 3, maxValidationActorChargeUsd: 0.2, actorId: 'a' },
    { token: 't', validatorToken: 'v' }
  );
  providers.request = async (_url, options = {}) => {
    seen.push(options.timeout);
    return { contactEnrichment: 'cot-contact-enrichment-v1', batchContract: 'cot-data-batch-v1',
      maxBatchSize: 3, actorMaxChargeUsd: 0.2 };
  };
  providers.apify = async () => ({ data: { id: 'a' } });

  return providers.preflight().then(() => {
    assert.ok(seen.length > 0, 'preflight must issue the capabilities request');
    assert.ok(seen[0] > 30000, `preflight timeout was ${seen[0]}ms, expected more than 30000ms`);
  });
});
