import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotationOCR } from './useAnnotationOCR';

const workerContext = vi.hoisted(() => ({ value: {} }));
vi.mock('@/lib/utils', async (importOriginal) => ({ ...await importOriginal(), cropImageBitmap: vi.fn(async () => ({ close: vi.fn() })) }));

vi.mock('@/context/WorkerContext', async (importOriginal) => ({
    ...await importOriginal(),
    useWorker: () => workerContext.value,
}));
vi.mock('@/context/TauriLocalOcrContext', () => ({ useTauriLocalOcrContext: () => ({}) }));

describe('sandbox OCR selection', () => {
    beforeEach(() => { localStorage.clear(); workerContext.value = { modelStatus: 'idle', activeModelKey: 'ppocrv6Line' }; });

    it('filters saved Modal models while retaining local selections', () => {
        localStorage.setItem('selectedOcrModelKeys', JSON.stringify(['lighton', 'suryaLocal']));
        const { result } = renderHook(() => useAnnotationOCR({ isSandbox: true }));
        expect(result.current.selectedOcrModelKeys).toEqual(['suryaLocal']);
        act(() => result.current.toggleOcrModel('lighton'));
        expect(result.current.selectedOcrModelKeys).toEqual(['suryaLocal']);
        act(() => result.current.toggleOcrModel('ppocrv6Line'));
        expect(JSON.parse(localStorage.getItem('selectedOcrModelKeys'))).toEqual(['lighton', 'suryaLocal']);
        expect(JSON.parse(localStorage.getItem('sandboxSelectedOcrModelKeys'))).toEqual(['suryaLocal', 'ppocrv6Line']);
    });

    it('falls back to browser OCR when only a Modal model was saved', () => {
        localStorage.setItem('sandboxSelectedOcrModelKeys', JSON.stringify(['lighton']));
        const { result } = renderHook(() => useAnnotationOCR({ isSandbox: true }));
        expect(result.current.selectedOcrModelKeys).toEqual(['ppocrv6Line']);
    });

    it('keeps Modal selection available outside the sandbox', () => {
        localStorage.setItem('selectedOcrModelKeys', JSON.stringify(['lighton']));
        const { result } = renderHook(() => useAnnotationOCR({ isSandbox: false }));
        expect(result.current.selectedOcrModelKeys).toEqual(['lighton']);
    });
});


describe('simultaneous browser OCR', () => {
    it('collects replies from both loaded workers even when Falcon is not active', async () => {
        localStorage.setItem('sandboxSelectedOcrModelKeys', JSON.stringify(['falconWebgpu', 'ppocrv6Line']));
        const workers = { falconWebgpu: new EventTarget(), ppocrv6Line: new EventTarget() };
        const runOcr = vi.fn(async (_bitmap, requestId, key) => {
            queueMicrotask(() => workers[key].dispatchEvent(new MessageEvent('message', {
                data: { status: 'complete', requestId, text: key === 'falconWebgpu' ? 'Falcon text' : 'Paddle text' }
            })));
        });
        workerContext.value = { workers, modelStates: { falconWebgpu: { status: 'ready' }, ppocrv6Line: { status: 'ready' } }, activeModelKey: 'ppocrv6Line', runOcr };
        const { result } = renderHook(() => useAnnotationOCR({ isSandbox: true, imageRef: { current: {} }, setDebugImageUrl: vi.fn() }));
        await act(async () => { await result.current.runBackgroundOcr({ x: 0, y: 0, w: 10, h: 10 }, 'shared'); });
        expect(runOcr.mock.calls.map(call => call[2])).toEqual(['falconWebgpu', 'ppocrv6Line']);
        expect(result.current.ocrResults.shared.map(candidate => candidate.text)).toEqual(['Falcon text', 'Paddle text']);
    });
});
