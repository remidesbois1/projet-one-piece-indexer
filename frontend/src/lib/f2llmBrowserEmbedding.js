let worker = null;
let nextRequestId = 1;
const pendingRequests = new Map();

function ensureWorker() {
    if (typeof window === 'undefined') {
        throw new Error('F2LLM navigateur indisponible côté serveur');
    }

    if (worker) return worker;

    worker = new Worker(new URL('../workers/f2llm.worker.js', import.meta.url), {
        type: 'module',
    });

    worker.addEventListener('message', (event) => {
        const { status, requestId, embedding, error } = event.data || {};

        if (status === 'download_progress') {
            window.dispatchEvent(new CustomEvent('f2llm-progress', { detail: event.data }));
            return;
        }

        if (!requestId || !pendingRequests.has(requestId)) return;

        const request = pendingRequests.get(requestId);
        if (status === 'complete' || status === 'ready') {
            pendingRequests.delete(requestId);
            request.resolve(embedding);
        } else if (status === 'error') {
            pendingRequests.delete(requestId);
            request.reject(new Error(error || 'Erreur F2LLM'));
        }
    });

    worker.addEventListener('error', (event) => {
        for (const request of pendingRequests.values()) {
            request.reject(new Error(event.message || 'Erreur worker F2LLM'));
        }
        pendingRequests.clear();
        worker = null;
    });

    return worker;
}

export function generateF2llmBrowserQueryEmbedding(text) {
    const currentWorker = ensureWorker();
    const requestId = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });
        currentWorker.postMessage({ type: 'embed', requestId, text });
    });
}
