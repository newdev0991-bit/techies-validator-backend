export function normalizeUkContactPhone(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!/^[+\d\s().-]+$/.test(raw)) return '';
    let digits = raw.replace(/^(\+44|0044)\s*\(0\)/, '$1').replace(/\D/g, '');
    if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
    else if (digits.startsWith('44')) digits = `0${digits.slice(2)}`;
    return /^0[1-9]\d{9}$/.test(digits) ? digits : '';
}
