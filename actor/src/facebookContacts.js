import { extractPageEvidence } from './facebookPageEvidence.js';
import { contactNameKey } from './contactTarget.js';
import { facebookUrl } from './cotUrls.js';
import { normalizeUkContactPhone } from './contactValues.js';

export function facebookContactRoot(value) {
    const url = facebookUrl(value);
    if (!url) return null;
    if (url.pathname === '/profile.php' && /^\d+$/.test(url.searchParams.get('id') || '')) {
        return `https://www.facebook.com/profile.php?id=${url.searchParams.get('id')}`;
    }
    const name = url.pathname.match(/^\/([a-z0-9._-]+)\/?$/i)?.[1];
    if (!name || name.endsWith('.php') || /^(?:groups|posts|reel|watch|share|login|checkpoint|help|privacy|settings|dialog|recover)$/i.test(name)) return null;
    return `https://www.facebook.com/${name}`;
}

export function facebookContactPages(value) {
    const root = facebookContactRoot(value);
    if (!root) return [];
    const url = new URL(root);
    url.searchParams.set('sk', 'about_contact_and_basic_info');
    return url.pathname === '/profile.php' ? [url.href] : [url.href, `${root}/about`];
}

export function applyFacebookContacts(result, evidence, sourceUrl) {
    for (const field of ['phone', 'address', 'website', 'email']) {
        if (result[field] || !evidence[field]) continue;
        if (field === 'phone' && !normalizeUkContactPhone(evidence[field])) continue;
        result[field] = evidence[field];
        if (field === 'website') continue;
        result[`${field}Verified`] = true;
        result[`${field}Source`] = field === 'address' ? 'facebook-page-contact' : 'facebook-page-page-text';
        result[`${field}SourceUrl`] = sourceUrl;
        result[`${field}IdentityStatus`] = 'matched';
    }
}

// At most two dedicated contact-page routes; no timeline crawl or retry loop.
export async function readFacebookContacts(result, page, name, { readPage, log = () => {} } = {}) {
    const attempts = [];
    if (!page || contactNameKey(page.pageName) !== contactNameKey(name)) return attempts;
    applyFacebookContacts(result, page, page.sourceUrl);
    for (const url of facebookContactPages(page.sourceUrl)) {
        if (result.phone && result.phoneVerified && result.address) break;
        try {
            const session = await readPage(url);
            if (session.failureReason) { attempts.push({ url, status: 'unavailable' }); continue; }
            const evidence = extractPageEvidence(session.html);
            if (contactNameKey(evidence.pageName) !== contactNameKey(name) ||
                (page.pageId && session.pageId !== page.pageId)) {
                attempts.push({ url, status: 'identity_mismatch' }); continue;
            }
            applyFacebookContacts(result, evidence, url);
            attempts.push({ url, status: 'read' });
        } catch { attempts.push({ url, status: 'failed' }); log('Contact page read failed safely'); }
    }
    return attempts;
}
