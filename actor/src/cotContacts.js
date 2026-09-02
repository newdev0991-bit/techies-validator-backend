// Add field-level provenance for COT without treating submitted data as scraping.
export function cotContactEvidence(output, result) {
    const matched = result.contactTarget ? result.contactTarget.verified === true : result.identityStatus === 'matched';
    const googleMatched = /^google-official-website/.test(result.phoneSource || '')
        && result.contactIdentityStatus === 'matched';
    const facebookPhone = matched && /^facebook-/.test(result.phoneSource || '');
    const facebookPhoneUrl = facebookPhone ? (result.phoneSourceUrl || result.facebookEvidenceUrl) : null;
    const phoneUrl = googleMatched ? result.phoneSourceUrl : facebookPhoneUrl;
    const phoneVerified = Boolean(result.phone && result.phoneVerified === true && phoneUrl && (facebookPhone || googleMatched));
    const observedAddress = typeof result.address === 'string' ? result.address.trim() : '';
    const googleAddress = /^google-official-website-(?:structured|address)$/.test(result.addressSource || '')
        && result.addressIdentityStatus === 'matched' && result.addressVerified === true;
    const facebookAddressUrl = matched ? (result.addressSourceUrl || result.facebookEvidenceUrl) : null;
    const addressUrl = googleAddress ? result.addressSourceUrl : facebookAddressUrl;
    const addressVerified = Boolean(observedAddress && addressUrl && (matched || googleAddress));
    let emailUrl = null;
    if (result.emailVerified === true) {
        if (/^google-official-website/.test(result.emailSource || '') && result.contactIdentityStatus === 'matched') {
            emailUrl = result.emailSourceUrl;
        } else if (matched && /^facebook-/.test(result.emailSource || '')) {
            emailUrl = result.facebookEvidenceUrl;
        }
    }
    const phoneSource = googleMatched ? 'google-official-website' : 'facebook-page-contact';
    const addressSource = googleAddress ? result.addressSource : result.addressSource === 'facebook-post-contact' ? result.addressSource : 'facebook-page-contact';
    return {
        contactTarget: result.contactTarget || null,
        contactLookup: result.contactLookup || null,
        evidence: {
            ...output.evidence,
            contactSourceUrls: [...new Set([phoneVerified ? phoneUrl : null, addressVerified ? addressUrl : null, emailUrl].filter(Boolean))],
            emailSourceUrls: emailUrl ? [emailUrl] : [],
        },
        contact: {
            ...output.contact,
            phone: phoneVerified ? result.phone : null,
            phoneVerified,
            phoneSource: phoneVerified ? result.phoneSource : null,
            source: phoneVerified ? phoneSource : null,
            sourceUrl: phoneVerified ? phoneUrl : null,
            identityStatus: phoneVerified ? 'matched' : 'unconfirmed',
        },
        address: {
            ...output.address,
            conflict: result.addressConflict === true,
            candidates: result.addressCandidates || [],
            full: addressVerified ? observedAddress : null,
            verified: addressVerified,
            identityStatus: addressVerified ? 'matched' : 'unconfirmed',
            source: addressVerified ? addressSource : null,
            sourceUrl: addressVerified ? addressUrl : null,
        },
    };
}
