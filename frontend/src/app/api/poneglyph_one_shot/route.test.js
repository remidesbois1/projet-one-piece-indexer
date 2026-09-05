// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as poneglyph } from './route';
import { POST as lighton } from '../local_lighton/route';
import { POST as ocr } from '../ocr/route';

describe('Modal OCR routes require authentication', () => {
    beforeEach(() => {
        vi.stubEnv('MODAL_OCR_ENABLED', 'true');
        vi.stubEnv('MODAL_OCR_API_KEY', 'test-key');
        for (const name of ['MODAL_PONEGLYPH_BBOX_URL', 'MODAL_LIGHTON_URL', 'MODAL_OCR_URL']) {
            vi.stubEnv(name, 'https://modal.example.test/ocr');
        }
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it.each([['poneglyph_one_shot', poneglyph], ['local_lighton', lighton], ['ocr', ocr]])(
        'rejects anonymous calls to %s before reading the image or contacting Modal', async (route, handler) => {
            const request = new Request(`https://app.example.test/api/${route}`, {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg', 'X-OCR-Allow-Anonymous': 'true' },
                body: 'unused image',
            });
            const response = await handler(request);
            expect(response.status).toBe(401);
            expect(await response.json()).toMatchObject({ code: 'OCR_AUTH_REQUIRED' });
            expect(request.bodyUsed).toBe(false);
            expect(fetch).not.toHaveBeenCalled();
        }
    );
});
