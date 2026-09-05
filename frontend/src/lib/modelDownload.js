const CHUNK_SIZE = 4 * 1024 * 1024;
const CACHE_NAME = 'poneglyph-model-parts-v1';

// Small range requests can resume independently, including after a page reload.
export async function downloadModel(url, { bytes, sha256, onProgress = () => {},
    fetchImpl = globalThis.fetch, cacheStorage = globalThis.caches,
    chunkSize = CHUNK_SIZE, concurrency = 4 } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Taille du modèle invalide.');
    const output = new Uint8Array(bytes);
    const count = Math.ceil(bytes / chunkSize);
    const progress = new Float64Array(count);
    const controller = new AbortController();
    const cache = await cacheStorage?.open(CACHE_NAME).catch(() => null);
    let lastUpdate = 0;
    const report = (force = false) => {
        const now = performance.now();
        if (force || now - lastUpdate >= 150) {
            lastUpdate = now;
            onProgress(Math.min(99, progress.reduce((a, b) => a + b, 0) / bytes * 100));
        }
    };
    const keyFor = index => {
        const key = new URL(url);
        key.searchParams.set('__poneglyph_part', `${sha256 || bytes}-${chunkSize}-${index}`);
        return key.href;
    };
    const read = async (response, start, expected, index) => {
        if (!response.body) throw new Error('Flux de téléchargement indisponible.');
        const reader = response.body.getReader();
        let received = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (received + value.length > expected) throw new Error('Réponse du serveur trop longue.');
                output.set(value, start + received);
                received += value.length;
                progress[index] = received;
                report();
            }
            if (received !== expected) throw new Error('Téléchargement incomplet.');
        } finally { await reader.cancel().catch(() => {}); }
    };
    const part = async index => {
        const start = index * chunkSize;
        const end = Math.min(bytes, start + chunkSize) - 1;
        const expected = end - start + 1;
        const key = keyFor(index);
        const cached = await cache?.match(key).catch(() => null);
        if (cached) {
            const data = new Uint8Array(await cached.arrayBuffer());
            if (data.length === expected) {
                output.set(data, start); progress[index] = expected; report(); return false;
            }
            await cache.delete(key).catch(() => {});
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await fetchImpl(url, {
                    headers: { Range: `bytes=${start}-${end}` },
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
                });
                // A server without range support is read once, before starting parallel requests.
                if (response.status === 200 && index === 0) {
                    await read(response, 0, bytes, 0);
                    return true;
                }
                if (response.status !== 206) {
                    await response.body?.cancel();
                    throw new Error(`Téléchargement HTTP ${response.status}.`);
                }
                const range = response.headers.get('content-range');
                if (range && range !== `bytes ${start}-${end}/${bytes}`) {
                    await response.body?.cancel();
                    throw new Error('Le serveur a renvoyé un bloc incorrect.');
                }
                await read(response, start, expected, index);
                await cache?.put(key, new Response(output.slice(start, end + 1))).catch(() => {});
                return false;
            } catch (error) {
                progress[index] = 0;
                if (controller.signal.aborted || attempt === 2) throw error;
            }
        }
    };
    try {
        const complete = await part(0);
        if (!complete) {
            let next = 1;
            await Promise.all(Array.from({ length: Math.min(concurrency, count - 1) }, async () => {
                while (next < count) await part(next++);
            }));
        }
        if (sha256) {
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', output));
            const actual = Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
            if (actual !== sha256) {
                await Promise.all(Array.from({ length: count }, (_, i) => cache?.delete(keyFor(i)).catch(() => {})));
                throw new Error('Empreinte du modèle incorrecte. Relancez le chargement.');
            }
        }
        report(true);
        return output;
    } catch (error) {
        controller.abort();
        throw error;
    }
}
