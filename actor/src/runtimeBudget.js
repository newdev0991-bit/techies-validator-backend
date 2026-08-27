export class OperationTimeoutError extends Error {
    constructor(label, timeoutMs) {
        super(`${label || 'operation'} exceeded ${timeoutMs}ms`);
        this.name = 'OperationTimeoutError';
        this.code = 'OPERATION_TIMEOUT';
        this.timeoutMs = timeoutMs;
    }
}

export async function runWithTimeout(task, { timeoutMs, label = 'operation', onTimeout } = {}) {
    const duration = Math.max(1, Math.floor(Number(timeoutMs) || 0));

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            callback(value);
        };

        timer = setTimeout(() => {
            if (settled) return;

            // Claim the outcome before cleanup so a late task result cannot beat its deadline.
            settled = true;
            let cleanupTimer = null;
            const cleanup = Promise.resolve()
                .then(() => onTimeout?.())
                .catch(() => {});
            const cleanupCeiling = new Promise((cleanupResolve) => {
                cleanupTimer = setTimeout(cleanupResolve, 1000);
            });

            void Promise.race([cleanup, cleanupCeiling]).then(() => {
                if (cleanupTimer) clearTimeout(cleanupTimer);
                reject(new OperationTimeoutError(label, duration));
            });
        }, duration);

        Promise.resolve()
            .then(task)
            .then(
                (value) => finish(resolve, value),
                (error) => finish(reject, error),
            );
    });
}
