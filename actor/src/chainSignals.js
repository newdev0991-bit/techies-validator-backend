const FRANCHISE_SIGNAL = /franchise/i;
const CHAIN_SIGNAL =
  /national|nationwide|international chain|multi-location|multiple-location|our locations|store locator|all locations/i;

/**
 * Convert scraper text signals into the deterministic business-size flags consumed by the backend.
 * A page advertising multiple locations is not an independent business even when it never uses
 * the exact words "national chain".
 */
export function classifyChainSignals(signals = []) {
  const normalized = Array.isArray(signals) ? signals.map((signal) => String(signal || '')) : [];
  const isFranchise = normalized.some((signal) => FRANCHISE_SIGNAL.test(signal));
  const isChain = isFranchise || normalized.some((signal) => CHAIN_SIGNAL.test(signal));
  return { isChain, isFranchise };
}
