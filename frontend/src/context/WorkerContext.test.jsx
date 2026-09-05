import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerProvider, useWorker } from './WorkerContext';

function Controls() {
    const { switchModel, loadModel, modelStates, runOcr } = useWorker();
    return <><button onClick={() => { switchModel('falconWebgpu'); loadModel('falconWebgpu'); }}>Falcon</button>
        <button onClick={() => { switchModel('ppocrv6Line'); loadModel('ppocrv6Line'); }}>Paddle</button>
        <button onClick={() => { runOcr('crop-f', 'f', 'falconWebgpu'); runOcr('crop-p', 'p', 'ppocrv6Line'); }}>Run both</button>
        <span>{JSON.stringify(modelStates)}</span></>;
}

describe('OCR worker switching', () => {
    afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
    it('keeps both models ready and routes each request to its own worker', async () => {
        localStorage.clear();
        const workers = [];
        class MockWorker {
            constructor(url) { this.url = String(url); workers.push(this); }
            postMessage = vi.fn();
            terminate = vi.fn();
            addEventListener(type, listener) { if (type === 'message') this.listener = listener; }
        }
        vi.stubGlobal('Worker', MockWorker);
        const view = render(<WorkerProvider><Controls /></WorkerProvider>);
        fireEvent.click(screen.getByText('Falcon'));
        await waitFor(() => expect(workers).toHaveLength(1));
        const falcon = workers[0];
        expect(falcon.url).toContain('falcon.worker.js');
        act(() => falcon.listener({ data: { status: 'ready', modelKey: 'falconWebgpu' } }));
        fireEvent.click(screen.getByText('Paddle'));
        const paddle = workers[1];
        expect(paddle.url).toContain('ocr.worker.js');
        expect(falcon.terminate).not.toHaveBeenCalled();
        act(() => paddle.listener({ data: { status: 'download_progress', progress: 40 } }));
        expect(screen.getByText(/"falconWebgpu":\{"status":"ready"/)).toBeTruthy();
        act(() => paddle.listener({ data: { status: 'ready', modelKey: 'ppocrv6Line' } }));
        fireEvent.click(screen.getByText('Falcon'));
        expect(workers).toHaveLength(2);
        expect(falcon.postMessage).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByText('Run both'));
        expect(falcon.postMessage).toHaveBeenLastCalledWith({ type: 'run', imageBlob: 'crop-f', requestId: 'f' }, []);
        expect(paddle.postMessage).toHaveBeenLastCalledWith({ type: 'run', imageBlob: 'crop-p', requestId: 'p' }, []);
        expect(paddle.terminate).not.toHaveBeenCalled();
        view.unmount();
        expect(falcon.terminate).toHaveBeenCalledOnce();
        expect(paddle.terminate).toHaveBeenCalledOnce();
    });
});
