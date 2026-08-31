import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { isAllowedGoogleContactUrl } from './googleContacts.js';

export function publicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return a > 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) &&
            !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
            !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19].includes(b));
    }
    // Restrict to global unicast IPv6; excludes loopback, mapped IPv4 and local nets.
    return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

export function assertPublicContactUrl(value) {
    const url = new URL(value);
    const ip = url.hostname.replace(/^\[|\]$/g, '');
    if (!isAllowedGoogleContactUrl(value) || (isIP(ip) && !publicAddress(ip))) throw new Error('unsafe-contact-url');
    return url;
}

// Validate the actual DNS answers used by the HTTP connection, including redirects.
export function publicContactLookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('unsafe-contact-dns'));
        if (options?.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
    });
}
