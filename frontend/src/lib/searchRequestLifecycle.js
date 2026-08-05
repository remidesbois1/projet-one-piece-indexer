export function createSearchRequestLifecycle() {
    let generation = 0;
    let activeController = null;

    const invalidate = () => {
        generation += 1;
        activeController?.abort();
        activeController = null;
        return generation;
    };

    return {
        begin() {
            invalidate();
            const controller = new AbortController();
            activeController = controller;
            return {
                requestId: generation,
                signal: controller.signal,
            };
        },

        invalidate,

        isCurrent(requestId) {
            return requestId === generation;
        },

        currentRequestId() {
            return generation;
        },

        commit(requestId, callback) {
            if (requestId !== generation) return false;
            callback();
            return true;
        },

        finish(requestId) {
            if (requestId !== generation) return false;
            activeController = null;
            return true;
        },
    };
}

export function createAbortError(message = 'Recherche annulee.') {
    if (typeof DOMException === 'function') {
        return new DOMException(message, 'AbortError');
    }

    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
}

export function isAbortError(error, signal) {
    return Boolean(
        signal?.aborted
        || error?.name === 'AbortError'
        || error?.name === 'CanceledError'
        || error?.code === 'ERR_CANCELED'
    );
}
