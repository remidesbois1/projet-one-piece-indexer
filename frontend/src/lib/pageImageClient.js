function getBackendApiUrl() {
    return (process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api').replace(/\/$/, '');
}

export async function fetchOriginalPageImage(pageId, accessToken, { signal, fetchImpl = fetch, thumbnail = false, width = 640 } = {}) {
    if (!pageId) throw new Error('Page id is required');
    if (!accessToken) throw new Error('Authentication is required to load the original page');

    const imagePath = thumbnail
        ? `/image/original/thumbnail?width=${encodeURIComponent(width)}`
        : '/image/original';
    const response = await fetchImpl(`${getBackendApiUrl()}/pages/${encodeURIComponent(pageId)}${imagePath}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
        credentials: 'omit',
        signal,
    });

    if (!response.ok) {
        throw new Error(response.status === 401
            ? 'Session expirée. Reconnectez-vous pour charger la page.'
            : "Impossible de charger l'image originale.");
    }

    return response.blob();
}

export function fetchOriginalPageThumbnail(pageId, accessToken, options = {}) {
    return fetchOriginalPageImage(pageId, accessToken, { ...options, thumbnail: true });
}
