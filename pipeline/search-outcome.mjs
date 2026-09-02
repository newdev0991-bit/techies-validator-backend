// A bounded partial result is useful, but never an exhaustive successful search.
export function searchOutcome(cycle) {
  const s = cycle.summary;
  if (cycle.searchComplete === true) return 'complete';
  const limits = { PAGE_BUDGET_EXHAUSTED: ['pageCount', 'maxPages'], REQUEST_BUDGET_EXHAUSTED: ['requestCount', 'maxRequests'] };
  const limit = limits[s?.stoppingReason];
  const count = limit && s[limit[0]], cap = limit && cycle.input?.[limit[1]];
  const matching = s?.schemaVersion === 'facebook-search-run-v1' && s.query === cycle.input?.query
    && s.success === false && s.partial === true && s.firstPageAccepted === true
    && Number.isSafeInteger(s.resultCount) && s.resultCount === cycle.total && cycle.total > 0
    && Number.isSafeInteger(count) && Number.isSafeInteger(cap) && cap > 0 && count === cap
    && s.resultCount <= cycle.input.maxResults
    && Number.isSafeInteger(s.pageCount) && s.pageCount <= cycle.input.maxPages
    && s.pageCount > 0 && Number.isSafeInteger(s.requestCount) && s.requestCount > 0 && s.requestCount <= cycle.input.maxRequests
    && !cycle.metrics?.invalid
    && (!s.error || s.error.code === s.stoppingReason)
    && ['FAILED','SUCCEEDED'].includes(cycle.runStatus);
  return limit && matching ? 'bounded_partial' : 'failed';
}
