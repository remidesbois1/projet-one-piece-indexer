import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from './supabaseClient';
import { postOcrImage } from './ocrProxyClient';

vi.mock('./supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

describe('postOcrImage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('sends the current access token only in the Authorization header', async () => {
        supabase.auth.getSession.mockResolvedValue({
            data: { session: { access_token: 'access-secret' } },
            error: null,
        });
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        const blob = new Blob(['jpeg'], { type: 'image/jpeg' });

        await postOcrImage('/api/local_lighton', blob, { fetchImpl });
        await postOcrImage('/api/local_lighton', blob, { fetchImpl });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [url, requestOptions] = fetchImpl.mock.calls[0];
        expect(url).toBe('/api/local_lighton');
        expect(url).not.toContain('access-secret');
        expect(requestOptions).toMatchObject({
            method: 'POST',
            body: blob,
            cache: 'no-store',
            credentials: 'same-origin',
        });
        expect(requestOptions.headers.Authorization).toBe('Bearer access-secret');
        expect(requestOptions.headers['Content-Type']).toBe('image/jpeg');
        expect(requestOptions.headers['X-OCR-Device-Id']).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
        expect(fetchImpl.mock.calls[1][1].headers['X-OCR-Device-Id'])
            .toBe(requestOptions.headers['X-OCR-Device-Id']);
    });

    it('fails before fetch when no authenticated session exists', async () => {
        supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
        const fetchImpl = vi.fn();

        await expect(postOcrImage(
            '/api/poneglyph_one_shot',
            new Blob(['jpeg'], { type: 'image/jpeg' }),
            { fetchImpl }
        )).rejects.toMatchObject({ code: 'OCR_AUTH_REQUIRED' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('allows an anonymous request only for the sandbox bbox endpoint', async () => {
        supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        const blob = new Blob(['jpeg'], { type: 'image/jpeg' });

        await postOcrImage('/api/poneglyph_one_shot', blob, {
            allowAnonymous: true,
            fetchImpl,
        });

        const [, requestOptions] = fetchImpl.mock.calls[0];
        expect(requestOptions.headers).not.toHaveProperty('Authorization');
        expect(requestOptions.headers['X-OCR-Device-Id']).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);

        await expect(postOcrImage('/api/local_lighton', blob, {
            allowAnonymous: true,
            fetchImpl,
        })).rejects.toMatchObject({ code: 'OCR_ANONYMOUS_NOT_ALLOWED' });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('keeps using Bearer auth in the sandbox when a session exists', async () => {
        supabase.auth.getSession.mockResolvedValue({
            data: { session: { access_token: 'sandbox-user-token' } },
            error: null,
        });
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

        await postOcrImage(
            '/api/poneglyph_one_shot',
            new Blob(['jpeg'], { type: 'image/jpeg' }),
            { allowAnonymous: true, fetchImpl }
        );

        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer sandbox-user-token');
    });

    it('fails closed when the session lookup fails', async () => {
        supabase.auth.getSession.mockRejectedValue(new Error('network details'));
        const fetchImpl = vi.fn();

        await expect(postOcrImage(
            '/api/ocr',
            new Blob(['png'], { type: 'image/png' }),
            { fetchImpl }
        )).rejects.toMatchObject({ code: 'OCR_AUTH_UNAVAILABLE' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('does not downgrade a malformed session result to anonymous access', async () => {
        supabase.auth.getSession.mockResolvedValue({ data: null, error: null });
        const fetchImpl = vi.fn();

        await expect(postOcrImage(
            '/api/poneglyph_one_shot',
            new Blob(['jpeg'], { type: 'image/jpeg' }),
            { allowAnonymous: true, fetchImpl }
        )).rejects.toMatchObject({ code: 'OCR_AUTH_UNAVAILABLE' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects unknown endpoints and unsupported image types before auth', async () => {
        const fetchImpl = vi.fn();

        await expect(postOcrImage(
            'https://attacker.example/upload',
            new Blob(['jpeg'], { type: 'image/jpeg' }),
            { fetchImpl }
        )).rejects.toMatchObject({ code: 'OCR_INVALID_ENDPOINT' });
        await expect(postOcrImage(
            '/api/ocr',
            new Blob(['svg'], { type: 'image/svg+xml' }),
            { fetchImpl }
        )).rejects.toMatchObject({ code: 'OCR_INVALID_IMAGE' });
        expect(supabase.auth.getSession).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
