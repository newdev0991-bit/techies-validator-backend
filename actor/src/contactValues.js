export function normalizeUkContactPhone(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!/^[+\d\s().-]+$/.test(raw)) return '';
    let digits = raw.replace(/^(\+44|0044)\s*\(0\)/, '$1').replace(/\D/g, '');
    if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
    else if (digits.startsWith('44')) digits = `0${digits.slice(2)}`;
    return /^0[1-9]\d{9}$/.test(digits) ? digits : '';
}


// Only visible caption text, never markup IDs. A candidate is not identity proof.
export function extractUkCaptionPhones(value) {
    if (typeof value !== 'string') return [];
    const found = new Set();
    const pattern = /(?<![\w+])(?:\+44|0044|0)(?:[ \t().-]*\d){9,12}(?!\w)/g;
    for (const line of value.normalize('NFKC').split(/[\r\n]+/)) {
        for (const match of line.matchAll(pattern)) {
            const phone = normalizeUkContactPhone(match[0]);
            const before = line.slice(0, match.index);
            const after = line.slice(match.index + match[0].length);
            const standalone = !before.trim() && !after.trim();
            const contactCue = /(?:\b(?:call|phone|telephone|tel|mobile|contact|whatsapp|ring)\b|[📞📱📲☎])[\s\S]{0,100}$/iu.test(before);
            if (phone && (standalone || contactCue) && !/\b(?:post|order|reference|booking)\s*(?:id|number|no)\s*[:#]?\s*$/i.test(before)) found.add(phone);
        }
    }
    return [...found];
}
