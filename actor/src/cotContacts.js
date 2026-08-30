// Add field-level provenance for COT without treating submitted data as scraping.
export function cotContactEvidence(output, result) {
    const matched = result.identityStatus === 'matched';
    const googleMatched = result.contactSource === 'google-official-website'
        && result.contactIdentityStatus === 'matched';
    const phoneVerified = result.phoneVerified === true && (matched || googleMatched);
    const observedAddress = typeof result.address === 'string' ? result.address.trim() : '';
    const pageUrl = output.canonicalUrl || '';
    const pageContactUrl = pageUrl
        ? `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}sk=about_contact_and_basic_info` : null;
    return {
        contact: {
            ...output.contact,
            phone: phoneVerified ? result.phone : null,
            phoneVerified,
            phoneSource: phoneVerified ? result.phoneSource : null,
            sourceUrl: phoneVerified ? result.contactSourceUrl || pageContactUrl : null,
            identityStatus: matched || googleMatched ? 'matched' : 'unconfirmed',
        },
        address: {
            ...output.address,
            full: matched && observedAddress ? observedAddress : null,
            verified: Boolean(matched && observedAddress && pageContactUrl),
            source: matched && observedAddress ? 'facebook-page-contact' : null,
            sourceUrl: matched && observedAddress ? pageContactUrl : null,
        },
    };
}
