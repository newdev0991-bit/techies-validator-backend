// Never serialize provider messages, stacks, request URLs, or input payloads.
const knownTypes = new Set([
  'invalid-input', 'invalid-input-schema', 'invalid-token', 'token-not-provided',
  'unauthorized', 'forbidden', 'actor-not-found', 'record-not-found',
  'build-not-found', 'actor-build-not-found', 'actor-is-not-ready',
  'actor-memory-limit-exceeded', 'platform-feature-disabled',
  'monthly-usage-hard-limit-reached', 'payment-required', 'rate-limit-exceeded'
]);

export function apifyFailure(error) {
  if (error?.name !== 'ApifyApiError') return null;
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode : 0;
  const type = knownTypes.has(error.type) ? error.type : 'unclassified';
  const categories = {
    400: ['APIFY_INPUT_REJECTED', 'Apify rejected the Actor request. Check the configured Actor input schema.'],
    401: ['APIFY_AUTH_FAILED', 'Apify rejected the backend credentials. Check the configured API token.'],
    402: ['APIFY_ACCOUNT_LIMIT', 'Apify refused the request because of an account or payment limit.'],
    403: ['APIFY_ACCESS_DENIED', 'Apify denied access. Check the backend token permissions and Actor sharing.'],
    404: ['APIFY_RESOURCE_NOT_FOUND', 'The configured Actor or build is unavailable to the backend token.'],
    429: ['APIFY_RATE_LIMIT', 'Apify rate-limited the request. Retry the saved batch later.']
  };
  // A spend cap and a permission denial both arrive as 403. Only the type separates them,
  // and sending an operator to check token permissions for an exhausted account wastes the
  // one signal that would have fixed it in a minute.
  const usageLimited = new Set([
    'platform-feature-disabled', 'monthly-usage-hard-limit-reached', 'payment-required'
  ]).has(type);
  const [code, message] = usageLimited
    ? ['APIFY_USAGE_LIMIT',
       'Apify refused the request because the account usage limit or spend cap was reached. Raise the limit or wait for the billing cycle to reset.']
    : categories[status] || ['APIFY_REQUEST_FAILED', 'Apify could not accept the batch request.'];
  return { status: 502, code, message, diagnostic: { providerStatus: status, providerType: type } };
}

export async function checkApifyAccess(actor, log = console.log) {
  try {
    const metadata = await actor.get();
    if (!metadata) {
      log('[apify-preflight] Actor is unavailable to the configured backend token.');
      return false;
    }
    const buildClient = await actor.defaultBuild();
    const build = await buildClient.get();
    const ready = build?.status === 'SUCCEEDED';
    log(`[apify-preflight] Actor readable; default build ${ready ? 'ready' : 'not ready'}. No run started.`);
    return ready;
  } catch (error) {
    const failure = apifyFailure(error);
    log(`[apify-preflight] ${JSON.stringify(failure?.diagnostic || { providerType: 'non-api-error' })}`);
    return false;
  }
}
