import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOriginalPageImage, fetchOriginalPageThumbnail } from './pageImageClient';

describe('fetchOriginalPageImage', () => {
    const originalBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;

    afterEach(() => {
        process.env.NEXT_PUBLIC_BACKEND_URL = originalBackendUrl;
    });

    it('sends the Supabase access token only in the Authorization header', async () => {
        process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.example.test/api/';
        const blob = new Blob(['image'], { type: 'image/avif' });
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });

        await expect(fetchOriginalPageImage('page 42', 'access-secret', { fetchImpl })).resolves.toBe(blob);

        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, options] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://api.example.test/api/pages/page%2042/image/original');
        expect(url).not.toContain('access-secret');
        expect(options.headers).toEqual({ Authorization: 'Bearer access-secret' });
        expect(options.cache).toBe('no-store');
        expect(options.credentials).toBe('omit');
    });

    it('fails before making a request when no token is available', async () => {
        const fetchImpl = vi.fn();
        await expect(fetchOriginalPageImage('42', null, { fetchImpl })).rejects.toThrow(/Authentication/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('turns an unauthorized response into a recoverable session message', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
        await expect(fetchOriginalPageImage('42', 'expired', { fetchImpl })).rejects.toThrow(/Session expirée/);
    });

    it('requests a server-side thumbnail at the requested display width', async () => {
        process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.example.test/api';
        const blob = new Blob(['thumbnail'], { type: 'image/avif' });
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });

        await expect(fetchOriginalPageThumbnail('42', 'access-secret', {
            width: 640,
            fetchImpl,
        })).resolves.toBe(blob);

        expect(fetchImpl).toHaveBeenCalledWith(
            'https://api.example.test/api/pages/42/image/original/thumbnail?width=640',
            expect.objectContaining({
                headers: { Authorization: 'Bearer access-secret' },
            })
        );
    });
});
