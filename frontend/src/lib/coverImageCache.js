const MAX_CACHED_COVERS = 120;

const cachedCoverUrls = new Map();
const pendingCoverRequests = new Map();

export function getCachedCoverUrl(sourceUrl) {
    return sourceUrl ? cachedCoverUrls.get(sourceUrl) || null : null;
}

export function preloadCoverUrl(sourceUrl) {
    if (!sourceUrl) return Promise.resolve(null);

    const cachedUrl = cachedCoverUrls.get(sourceUrl);
    if (cachedUrl) return Promise.resolve(cachedUrl);

    const pendingRequest = pendingCoverRequests.get(sourceUrl);
    if (pendingRequest) return pendingRequest;

    const request = fetch(sourceUrl, { cache: 'force-cache' })
        .then((response) => {
            if (!response.ok) throw new Error(`Cover request failed with ${response.status}`);
            return response.blob();
        })
        .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            cachedCoverUrls.set(sourceUrl, objectUrl);

            while (cachedCoverUrls.size > MAX_CACHED_COVERS) {
                const oldestSourceUrl = cachedCoverUrls.keys().next().value;
                const oldestObjectUrl = cachedCoverUrls.get(oldestSourceUrl);
                cachedCoverUrls.delete(oldestSourceUrl);
                URL.revokeObjectURL(oldestObjectUrl);
            }

            return objectUrl;
        })
        .finally(() => {
            pendingCoverRequests.delete(sourceUrl);
        });

    pendingCoverRequests.set(sourceUrl, request);
    return request;
}

export function clearCoverUrlCache() {
    for (const objectUrl of cachedCoverUrls.values()) URL.revokeObjectURL(objectUrl);
    cachedCoverUrls.clear();
    pendingCoverRequests.clear();
}
