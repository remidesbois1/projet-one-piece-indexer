import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('./aiModelConfig', () => ({
    getAiModelConfig: vi.fn().mockResolvedValue({
        model_chatgpt_ocr: 'gpt-5.6-luna',
        chatgpt_reasoning_effort: 'low',
        chatgpt_fast_mode: false,
    }),
}));

vi.mock('./promptConfig', () => ({
    getPrompt: vi.fn().mockResolvedValue('prompt-ocr-page'),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke,
    isTauri: () => true,
}));

import {
    getChatGptStatus,
    logoutChatGpt,
    runChatGptPageOcr,
} from './chatGptDesktop';

describe('chatGptDesktop', () => {
    beforeEach(() => {
        invoke.mockReset();
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
            model: 'gpt-5.6-luna',
            fast_mode: false,
            reasoning_effort: 'low',
            prompt: 'prompt-ocr-page',
        });
    });

    it('can override the global OpenAI OCR settings and prompt for a request', async () => {
        invoke.mockResolvedValue({ bubbles: [] });
        await runChatGptPageOcr(new Blob(['image'], { type: 'image/jpeg' }), {
            model: 'gpt-5.6-terra',
            fastMode: true,
            reasoningEffort: 'high',
            prompt: 'prompt-personnalise',
        });
        expect(invoke).toHaveBeenCalledWith('run_chatgpt_page_ocr', expect.objectContaining({
            model: 'gpt-5.6-terra',
            fast_mode: true,
            reasoning_effort: 'high',
            prompt: 'prompt-personnalise',
        }));
    });

    it('clears the desktop session without touching browser storage', async () => {
        invoke.mockResolvedValue({ connected: false, model: 'gpt-5.6-luna' });
        await logoutChatGpt();
        expect(invoke).toHaveBeenCalledWith('chatgpt_logout', {});
    });
});
