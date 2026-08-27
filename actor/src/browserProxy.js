export function createProxySessionId(runId) {
    const safeRunId = String(runId || Date.now())
        .replace(/[^0-9a-zA-Z._~]/g, '')
        .slice(0, 45);
    return `fb_${safeRunId || Date.now()}`.slice(0, 50);
}

export function parseAuthenticatedProxyUrl(rawUrl) {
    const parsed = new URL(String(rawUrl || ''));
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.port) {
        throw new Error('The proxy URL must include an HTTP(S) host and port.');
    }
    if (!parsed.username || !parsed.password) {
        throw new Error('The proxy URL must include authentication credentials.');
    }

    return {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        credentials: {
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
        },
    };
}
