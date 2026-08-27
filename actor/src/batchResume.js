function normalizedRequestKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/**
 * Return request keys whose output is already durable in this run's default dataset.
 *
 * Apify can migrate a running Actor to another host. The process then starts from the top while
 * retaining the run's storages. Reading the dataset before the loop makes that restart resumable:
 * completed rows are not scraped or pushed a second time, while the interrupted row is retried.
 */
export function completedBatchRequestKeys(requests = [], datasetItems = []) {
    const expectedUrls = new Map(
        requests.map((request) => [normalizedRequestKey(request?.requestKey), String(request?.url || '').trim()]),
    );
    const completed = new Set();

    for (const item of datasetItems) {
        const requestKey = normalizedRequestKey(item?.requestKey);
        if (!requestKey || !expectedUrls.has(requestKey)) continue;

        const expectedUrl = expectedUrls.get(requestKey);
        const outputUrl = String(item?.inputUrl || '').trim();
        if (outputUrl !== expectedUrl) {
            throw new Error(`Stored batch output URL mismatch for requestKey "${requestKey}".`);
        }
        completed.add(requestKey);
    }

    return completed;
}
