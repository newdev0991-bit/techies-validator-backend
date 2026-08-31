export function buildActorRequests(input = {}) {
    const fallbackLead = input?.lead && typeof input.lead === 'object' ? input.lead : {};
    const batched = Array.isArray(input?.requests) ? input.requests : [];

    if (batched.length) {
        const requests = batched
            .map((entry, index) => {
                const value = entry && typeof entry === 'object' ? entry : {};
                const url = String(value.url || value.startUrl?.url || '').trim();
                const lead = value.lead && typeof value.lead === 'object' ? value.lead : fallbackLead;
                const suppliedKey = value.requestKey ?? value.id;
                const requestKey =
                    suppliedKey == null || String(suppliedKey).trim() === ''
                        ? String(index)
                        : String(suppliedKey).trim();
                return { url, lead, requestKey, ...(value.searchAuthor && typeof value.searchAuthor === 'object'
                    ? { searchAuthor: value.searchAuthor } : {}), ...(value.contactTarget && typeof value.contactTarget === 'object'
                    ? { contactTarget: value.contactTarget } : {}) };
            })
            .filter((entry) => entry.url);

        const seenRequestKeys = new Set();
        for (const request of requests) {
            if (seenRequestKeys.has(request.requestKey)) {
                throw new Error(`Duplicate requestKey in batched Actor input: ${request.requestKey}`);
            }
            seenRequestKeys.add(request.requestKey);
        }

        return requests;
    }

    let urls = [input?.url].filter(Boolean);
    if (Array.isArray(input?.urls)) {
        urls = input.urls;
    } else if (Array.isArray(input?.startUrls)) {
        urls = input.startUrls.map((entry) => entry?.url);
    }

    return urls
        .map((url, index) => ({
            url: String(url || '').trim(),
            lead: fallbackLead,
            requestKey: String(index),
        }))
        .filter((entry) => entry.url);
}
