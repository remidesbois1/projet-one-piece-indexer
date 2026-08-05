import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetectionProvider, useDetection } from './DetectionContext';

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

    removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
    }

    emit(data) {
        for (const listener of [...(this.listeners.get('message') || [])]) {
            listener({ data });
        }
    }
}

WorkerMock.instances = [];

describe('DetectionContext request cancellation', () => {
    let detection;

    function Consumer() {
        detection = useDetection();
        return null;
    }

    beforeEach(() => {
        WorkerMock.instances = [];
        vi.stubGlobal('Worker', WorkerMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('routes responses by requestId and ignores a cancelled image result', async () => {
        render(
            <DetectionProvider>
                <Consumer />
            </DetectionProvider>
        );
        await waitFor(() => expect(WorkerMock.instances).toHaveLength(1));
        const worker = WorkerMock.instances[0];

        act(() => detection.loadDetectionModel());
        act(() => worker.emit({ status: 'ready' }));
        await waitFor(() => expect(detection.detectionStatus).toBe('ready'));

        const firstController = new AbortController();
        const firstPromise = detection.detectBubbles(new Blob(['A']), {
            signal: firstController.signal,
        });
        const secondPromise = detection.detectBubbles(new Blob(['B']));
        const runMessages = worker.postMessage.mock.calls
            .map(call => call[0])
            .filter(message => message.type === 'run');

        expect(runMessages).toHaveLength(2);
        expect(runMessages[0].requestId).not.toBe(runMessages[1].requestId);

        firstController.abort();
        await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.postMessage).toHaveBeenCalledWith({
            type: 'cancel',
            requestId: runMessages[0].requestId,
        });

        let secondSettled = false;
        secondPromise.finally(() => {
            secondSettled = true;
        });
        act(() => worker.emit({
            status: 'complete',
            requestId: runMessages[0].requestId,
            boxes: ['A'],
        }));
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        act(() => worker.emit({
            status: 'complete',
            requestId: runMessages[1].requestId,
            boxes: ['B'],
        }));
        await expect(secondPromise).resolves.toEqual(['B']);
    });
});
