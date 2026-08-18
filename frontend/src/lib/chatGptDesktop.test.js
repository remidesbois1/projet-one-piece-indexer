import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
    invoke,
    isTauri: () => true,
}));

import {
    CHATGPT_FAST_MODE_STORAGE_KEY,
    getChatGptFastMode,
    getChatGptStatus,
    logoutChatGpt,
    runChatGptPageOcr,
    setChatGptFastMode,
} from './chatGptDesktop';

describe('chatGptDesktop', () => {
    beforeEach(() => {
        invoke.mockReset();
        localStorage.clear();
    });

    it('reads the in-memory desktop authentication status', async () => {
        invoke.mockResolvedValue({ connected: true, email: 'reader@example.com', model: 'gpt-5.6-luna' });
        await expect(getChatGptStatus()).resolves.toMatchObject({
            available: true,
            connected: true,
            model: 'gpt-5.6-luna',
        });
        expect(invoke).toHaveBeenCalledWith('get_chatgpt_auth_status', {});
    });

    it('sends an image only through the scoped Tauri OCR command', async () => {
        invoke.mockResolvedValue({ bubbles: [] });
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
        await runChatGptPageOcr(blob);
        expect(invoke).toHaveBeenCalledWith('run_chatgpt_page_ocr', {
            image_bytes_base64: 'AQID',
            mime_type: 'image/png',
            fast_mode: false,
        });
    });

    it('persists and sends the Luna latency preference', async () => {
        invoke.mockResolvedValue({ bubbles: [] });
        setChatGptFastMode(true);

        expect(getChatGptFastMode()).toBe(true);
        expect(localStorage.getItem(CHATGPT_FAST_MODE_STORAGE_KEY)).toBe('true');

        await runChatGptPageOcr(new Blob(['image'], { type: 'image/jpeg' }));
        expect(invoke).toHaveBeenCalledWith('run_chatgpt_page_ocr', expect.objectContaining({
            fast_mode: true,
        }));
    });

    it('clears the desktop session without touching browser storage', async () => {
        invoke.mockResolvedValue({ connected: false, model: 'gpt-5.6-luna' });
        await logoutChatGpt();
        expect(invoke).toHaveBeenCalledWith('chatgpt_logout', {});
    });
});
