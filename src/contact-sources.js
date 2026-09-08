/**
 * Contact sources the search Actor's Google fallback can publish.
 *
 * It once read only a business's own website, so a single literal `'google-official-website'` was
 * enough and that literal was repeated in three places. It now also reads curated business
 * listings - directories, public registers, booking platforms - because a small trader with no
 * website has no name-carrying domain for the official-site rule to find, and those are exactly
 * the businesses whose phone is missing.
 *
 * Each kind arrives under its own source label so a consumer can tell a first-party page from a
 * third-party one. A label not listed here is treated as unverified rather than trusted: an
 * unrecognised source can never quietly become a callable contact.
 */
export const GOOGLE_CONTACT_SOURCE_KINDS = {
  'google-official-website': 'official',
  'google-directory-listing': 'listing',
  'google-registry-listing': 'listing',
  'google-booking-listing': 'listing'
};

export const GOOGLE_CONTACT_SOURCES = Object.keys(GOOGLE_CONTACT_SOURCE_KINDS);

/**
 * The kind of Google source a label names, or '' when it is not one this codebase accepts.
 *
 * Per-field labels extend the source with the element they were read from, for example
 * `google-official-website-tel` or `google-official-website-mailto`, so a prefix match is needed
 * alongside the exact one.
 */
export function googleContactSourceKind(value) {
  const label = String(value || '').trim();
  if (GOOGLE_CONTACT_SOURCE_KINDS[label]) return GOOGLE_CONTACT_SOURCE_KINDS[label];
  const base = GOOGLE_CONTACT_SOURCES.find(known => label.startsWith(`${known}-`));
  return base ? GOOGLE_CONTACT_SOURCE_KINDS[base] : '';
}
