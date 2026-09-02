const postcode = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i;
const street = /\b(?:street|road|lane|avenue|drive|way|place|square|close|court|estate|terrace|crescent|highway|st\.?|rd\.?)\b/i;
const emailOrUrl = /https?:\/\/|\b\S+@\S+\.\S+|(?:^|\s)@[a-z_]/i;

// COT proof captions only: join address blocks, never page chrome or other posts.
export function proofAddresses(caption) {
    const lines = String(caption || '').split('\n').map(s => s.trim()).filter(Boolean);
    const candidates = [];
    for (let end = 0; end < lines.length; end++) {
        if (!postcode.test(lines[end])) continue;
        for (let start = end; start >= Math.max(0, end - 3); start--) {
            let quote = lines.slice(start, end + 1).join('\n');
            if (quote.length > 400 || emailOrUrl.test(quote)) break;
            if (!street.test(quote)) continue;
            let value = quote.replace(/^[\s\p{Extended_Pictographic}\uFE0F]+/gu, '')
                .replace(/^.*?(?:premises\s*@|find us at\s*:|moved to\s*:|address\s*:|located at\s*:)\s*/is, '')
                .replace(/\s*[\p{Extended_Pictographic}\uFE0F]+\s*/gu, ' ').trim();
            const match = value.match(postcode);
            value = value.slice(0, match.index + match[0].length).replace(/\s*\n\s*/g, ', ').trim();
            // Include a building-name line directly preceding a bare street.
            if (!/\d/.test(value.replace(postcode, '')) && start > 0 &&
                /^(?:The |Unit |Suite |Building )[^.!?]{1,65}$/i.test(lines[start - 1])) {
                value = `${lines[start - 1]}, ${value}`; quote = `${lines[start - 1]}\n${quote}`;
            }
            if (street.test(value) && value.length >= 12) candidates.push({ value, quote });
            break;
        }
    }
    return [...new Map(candidates.map(c => [addressKey(c.value), c])).values()];
}

export function addressKey(value) {
    return String(value || '').toLowerCase().replace(postcode, '').replace(/\b(?:united kingdom|uk)\b/g, '')
        .replace(/\brd\b/g, 'road').replace(/\bst\b/g, 'street').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function addressesAgree(a, b) {
    const left = addressKey(a), right = addressKey(b);
    const pa = String(a).match(postcode)?.[0].replace(/\s/g, '').toLowerCase();
    const pb = String(b).match(postcode)?.[0].replace(/\s/g, '').toLowerCase();
    if (pa && pb && pa !== pb) return false;
    return Boolean(left && right && (left === right || ` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `)));
}
