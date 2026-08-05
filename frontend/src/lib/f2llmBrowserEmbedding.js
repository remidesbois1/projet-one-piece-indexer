import { createAbortError } from './searchRequestLifecycle';

let worker = null;
let nextRequestId = 1;
const pendingRequests = new Map();

function takePendingRequest(requestId) {
    const request = pendingRequests.get(requestId);
    if (!request) return null;
    pendingRequests.delete(requestId);
    request.cleanup?.();
    return request;
}

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

        const request = takePendingRequest(requestId);
        if (status === 'complete' || status === 'ready') {
            request.resolve(embedding);
        } else if (status === 'error') {
            request.reject(new Error(error || 'Erreur F2LLM'));
        }
    });

    worker.addEventListener('error', (event) => {
        for (const requestId of [...pendingRequests.keys()]) {
            const request = takePendingRequest(requestId);
            request.reject(new Error(event.message || 'Erreur worker F2LLM'));
        }
        worker = null;
    });

    return worker;
}

export function generateF2llmBrowserQueryEmbedding(text, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(createAbortError());

    const currentWorker = ensureWorker();
    const requestId = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve, reject) => {
        const handleAbort = () => {
            const request = takePendingRequest(requestId);
            if (!request) return;
            currentWorker.postMessage({ type: 'cancel', requestId });
            request.reject(createAbortError());
        };
        const cleanup = () => signal?.removeEventListener('abort', handleAbort);

        pendingRequests.set(requestId, { resolve, reject, cleanup });
        signal?.addEventListener('abort', handleAbort, { once: true });

        try {
            currentWorker.postMessage({ type: 'embed', requestId, text });
        } catch (error) {
            takePendingRequest(requestId)?.reject(error);
        }
    });
}
