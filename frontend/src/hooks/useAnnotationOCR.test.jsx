import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotationOCR } from './useAnnotationOCR';

vi.mock('@/context/WorkerContext', async (importOriginal) => ({
    ...await importOriginal(),
    useWorker: () => ({ modelStatus: 'idle', activeModelKey: 'ppocrv6Line' }),
}));
vi.mock('@/context/TauriLocalOcrContext', () => ({ useTauriLocalOcrContext: () => ({}) }));

describe('sandbox OCR selection', () => {
    beforeEach(() => localStorage.clear());

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
