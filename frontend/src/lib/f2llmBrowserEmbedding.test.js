import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class WorkerMock {
    constructor() {
        this.listeners = new Map();
        this.postMessage = vi.fn();
        WorkerMock.instances.push(this);
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    emit(type, payload) {
        for (const listener of this.listeners.get(type) || []) {
            listener(type === 'message' ? { data: payload } : payload);
        }
    }
}

WorkerMock.instances = [];

describe('F2LLM browser embedding cancellation', () => {
    beforeEach(() => {
        vi.resetModules();
        WorkerMock.instances = [];
        vi.stubGlobal('Worker', WorkerMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('rejects on abort, removes the pending request and notifies the worker', async () => {
        const { generateF2llmBrowserQueryEmbedding } = await import('./f2llmBrowserEmbedding');
        const controller = new AbortController();
        const embeddingPromise = generateF2llmBrowserQueryEmbedding('gold roger', {
            signal: controller.signal,
        });
        const currentWorker = WorkerMock.instances[0];
        const embedMessage = currentWorker.postMessage.mock.calls[0][0];

        controller.abort();

        await expect(embeddingPromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(currentWorker.postMessage).toHaveBeenLastCalledWith({
            type: 'cancel',
            requestId: embedMessage.requestId,
        });

        currentWorker.emit('message', {
            status: 'complete',
            requestId: embedMessage.requestId,
            embedding: ['obsolete'],
        });
    });

    it('allows B to complete after A is aborted and ignores A late completion', async () => {
        const { generateF2llmBrowserQueryEmbedding } = await import('./f2llmBrowserEmbedding');
        const firstController = new AbortController();
        const firstPromise = generateF2llmBrowserQueryEmbedding('first query', {
            signal: firstController.signal,
        });
        const secondPromise = generateF2llmBrowserQueryEmbedding('second query');
        const currentWorker = WorkerMock.instances[0];
        const firstRequestId = currentWorker.postMessage.mock.calls[0][0].requestId;
        const secondRequestId = currentWorker.postMessage.mock.calls[1][0].requestId;

        firstController.abort();
        currentWorker.emit('message', {
            status: 'complete',
            requestId: secondRequestId,
            embedding: ['B'],
        });
        currentWorker.emit('message', {
            status: 'complete',
            requestId: firstRequestId,
            embedding: ['A'],
        });

        await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
        await expect(secondPromise).resolves.toEqual(['B']);
    });
});
