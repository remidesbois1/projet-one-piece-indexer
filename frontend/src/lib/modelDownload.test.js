import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadModel } from './modelDownload';

const source = Uint8Array.from({ length: 23 }, (_, i) => i);
const options = { bytes: source.length, chunkSize: 8, cacheStorage: undefined };
const url = 'https://example.com/weights';
function serve(_url, { headers }) {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range).map(Number);
    return new Response(source.slice(start, end + 1), {
        status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}` },
    });
}
function storage() {
    const entries = new Map();
    const cache = {
        match: async key => entries.get(key)?.clone(),
        put: async (key, response) => { entries.set(key, response.clone()); },
        delete: async key => entries.delete(key),
    };
    return { open: async () => cache, entries };
}
describe('model download', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('assembles ranges in order and reads the next load from cache', async () => {
        const fetchImpl = vi.fn(serve), cacheStorage = storage();
        expect(await downloadModel(url, { ...options, fetchImpl, cacheStorage })).toEqual(source);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        fetchImpl.mockClear();
        expect(await downloadModel(url, { ...options, fetchImpl, cacheStorage })).toEqual(source);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('retries truncated ranges and reuses completed parts after an interruption', async () => {
        const cacheStorage = storage();
        const broken = vi.fn((url, options) => options.headers.Range === 'bytes=8-15'
            ? new Response(new Uint8Array(1), { status: 206 }) : serve(url, options));
        await expect(downloadModel(url, { ...options, concurrency: 1, fetchImpl: broken, cacheStorage })).rejects.toThrow('incomplet');
        const fetchImpl = vi.fn(serve);
        expect(await downloadModel(url, { ...options, fetchImpl, cacheStorage })).toEqual(source);
        expect(fetchImpl.mock.calls.map(([, o]) => o.headers.Range)).toEqual(['bytes=8-15', 'bytes=16-22']);
    });
    it('accepts a server without range support in one request', async () => {
        const fetchImpl = vi.fn(async () => new Response(source));
        expect(await downloadModel(url, { ...options, fetchImpl })).toEqual(source);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it('rejects incorrect Content-Range offsets', async () => {
        const fetchImpl = vi.fn(async () => new Response(new Uint8Array(8), {
            status: 206, headers: { 'Content-Range': 'bytes 8-15/23' },
        }));
        await expect(downloadModel(url, { ...options, fetchImpl })).rejects.toThrow('bloc incorrect');
    });
    it('removes corrupt cached parts when the full checksum does not match', async () => {
        vi.stubGlobal('crypto', webcrypto);
        const cacheStorage = storage();
        await expect(downloadModel(url, { ...options, fetchImpl: serve, cacheStorage, sha256: 'incorrect' })).rejects.toThrow('Empreinte');
        expect(cacheStorage.entries.size).toBe(0);
    });
});
