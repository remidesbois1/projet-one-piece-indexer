// @vitest-environment node

import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createModalOcrHandler } from './modalOcrProxy';
import { OcrProxyError } from './modalOcrSecurity';

const BASE_ENV = Object.freeze({
    MODAL_OCR_ENABLED: 'true',
    MODAL_TEST_URL: 'https://modal.example.test/ocr',
    MODAL_OCR_API_KEY: 'modal-secret',
});
const BASE_CONFIG = Object.freeze({
    id: 'test-ocr',
    urlEnv: 'MODAL_TEST_URL',
    quotaCost: 2,
    allowAnonymous: false,
    timeoutMs: 250,
    responseKind: 'text',
});

let fixtures;

beforeAll(async () => {
    const source = {
        create: {
            width: 4,
            height: 3,
            channels: 3,
            background: { r: 245, g: 245, b: 245 },
        },
    };
    fixtures = {
        jpeg: await sharp(source).jpeg().toBuffer(),
        png: await sharp(source).png().toBuffer(),
        webp: await sharp(source).webp().toBuffer(),
    };
});

function imageRequest(buffer, contentType, extraHeaders = {}) {
    return new Request('https://app.example.test/api/ocr', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer browser-secret',
            'Content-Type': contentType,
            'X-OCR-Device-Id': 'browser-device-123456',
            ...extraHeaders,
        },
        body: buffer,
    });
}

function createHarness({
    env = BASE_ENV,
    config = BASE_CONFIG,
    authenticate = vi.fn().mockResolvedValue({
        user: { id: 'verified-user-id' },
        userId: 'verified-user-id',
        isAnonymous: false,
    }),
    consumeQuota = vi.fn().mockResolvedValue({ allowed: true }),
    fetchImpl = vi.fn().mockResolvedValue(Response.json({ text: 'Texte reconnu' })),
    inspectImage,
} = {}) {
    const dependencies = { env, authenticate, consumeQuota, fetchImpl };
    if (inspectImage) dependencies.inspectImage = inspectImage;
    return {
        authenticate,
        consumeQuota,
        fetchImpl,
        handler: createModalOcrHandler(config, dependencies),
    };
}

describe('createModalOcrHandler request validation', () => {
    it('rejects unauthenticated callers with the real shared auth dependency', async () => {
        const handler = createModalOcrHandler(BASE_CONFIG, { env: BASE_ENV });
        const request = new Request('https://app.example.test/api/ocr', {
            method: 'POST',
            headers: {
                'Content-Type': 'image/jpeg',
                'X-OCR-Allow-Anonymous': 'true',
                'X-OCR-Quota-Cost': '0',
            },
            body: fixtures.jpeg,
        });

        const response = await handler(request);

        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toContain('no-store');
        await expect(response.json()).resolves.toMatchObject({ code: 'OCR_AUTH_REQUIRED' });
        expect(request.bodyUsed).toBe(false);
    });

    it('allows only an explicitly configured anonymous route at the fixed server cost', async () => {
        const consumeQuota = vi.fn().mockResolvedValue({ allowed: true });
        const fetchImpl = vi.fn().mockResolvedValue(Response.json({ text: 'Démo publique' }));
        const handler = createModalOcrHandler(
            { ...BASE_CONFIG, allowAnonymous: true, quotaCost: 5 },
            { env: BASE_ENV, consumeQuota, fetchImpl }
        );
        const request = new Request('https://app.example.test/api/poneglyph_one_shot', {
            method: 'POST',
            headers: {
                'Content-Type': 'image/jpeg',
                'X-OCR-Quota-Cost': '0',
                'X-OCR-Anonymous-Daily-Units': '999999',
            },
            body: fixtures.jpeg,
        });

        const response = await handler(request);

        expect(response.status).toBe(200);
        expect(consumeQuota).toHaveBeenCalledWith({
            request,
            userId: null,
            isAnonymous: true,
            cost: 5,
        }, { env: BASE_ENV });
        expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('never downgrades a supplied malformed Bearer credential to anonymous access', async () => {
        const consumeQuota = vi.fn();
        const fetchImpl = vi.fn();
        const handler = createModalOcrHandler(
            { ...BASE_CONFIG, allowAnonymous: true, quotaCost: 5 },
            { env: BASE_ENV, consumeQuota, fetchImpl }
        );
        const request = imageRequest(fixtures.jpeg, 'image/jpeg', {
            Authorization: 'Bearer invalid token with spaces',
        });

        const response = await handler(request);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({ code: 'OCR_AUTH_INVALID' });
        expect(consumeQuota).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        ['jpeg', 'image/jpeg'],
        ['png', 'image/png'],
        ['webp', 'image/webp'],
    ])('accepts a valid %s image and forwards only server credentials', async (format, contentType) => {
        const harness = createHarness();
        const request = imageRequest(fixtures[format], contentType);

        const response = await harness.handler(request);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ text: 'Texte reconnu' });
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        expect(response.headers.get('pragma')).toBe('no-cache');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(harness.authenticate).toHaveBeenCalledWith(request, {
            env: BASE_ENV,
            allowAnonymous: false,
        });
        expect(harness.consumeQuota).toHaveBeenCalledWith(
            {
                request,
                userId: 'verified-user-id',
                isAnonymous: false,
                cost: 2,
            },
            { env: BASE_ENV }
        );

        expect(harness.fetchImpl).toHaveBeenCalledOnce();
        const [upstreamUrl, upstreamOptions] = harness.fetchImpl.mock.calls[0];
        expect(upstreamUrl).toBe('https://modal.example.test/ocr');
        expect(upstreamOptions.headers).toEqual({
            'Content-Length': String(fixtures[format].byteLength),
            'Content-Type': contentType,
            'X-API-Key': 'modal-secret',
        });
        expect(upstreamOptions.headers).not.toHaveProperty('Authorization');
        expect(upstreamOptions.body).toEqual(fixtures[format]);
        expect(upstreamOptions.cache).toBe('no-store');
    });

    it('rejects a declared oversized body before auth, quota, or buffering', async () => {
        const harness = createHarness({
            config: { ...BASE_CONFIG, imageLimits: { maxBytes: 8 } },
        });
        const request = imageRequest(fixtures.jpeg, 'image/jpeg', { 'Content-Length': '9' });

        const response = await harness.handler(request);

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({ code: 'OCR_BODY_TOO_LARGE' });
        expect(request.bodyUsed).toBe(false);
        expect(harness.authenticate).not.toHaveBeenCalled();
        expect(harness.consumeQuota).not.toHaveBeenCalled();
        expect(harness.fetchImpl).not.toHaveBeenCalled();
    });

    it('stops a chunked request as soon as its streaming byte limit is crossed', async () => {
        const requestBody = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5, 6]));
                controller.close();
            },
        });
        const request = new Request('https://app.example.test/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg' },
            body: requestBody,
            duplex: 'half',
        });
        const harness = createHarness({
            config: { ...BASE_CONFIG, imageLimits: { maxBytes: 4 } },
        });

        const response = await harness.handler(request);

        expect(response.status).toBe(413);
        expect(harness.authenticate).toHaveBeenCalledOnce();
        expect(harness.consumeQuota).toHaveBeenCalledOnce();
        expect(harness.fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects unsupported encodings and MIME types before auth', async () => {
        const harness = createHarness();
        const encoded = imageRequest(fixtures.jpeg, 'image/jpeg', { 'Content-Encoding': 'gzip' });
        const unsupported = imageRequest(fixtures.jpeg, 'image/gif');

        expect((await harness.handler(encoded)).status).toBe(415);
        expect((await harness.handler(unsupported)).status).toBe(415);
        expect(harness.authenticate).not.toHaveBeenCalled();
        expect(harness.fetchImpl).not.toHaveBeenCalled();
    });

    it('checks magic bytes against MIME and rejects corrupt images', async () => {
        const mismatchedHarness = createHarness();
        const mismatchResponse = await mismatchedHarness.handler(
            imageRequest(fixtures.jpeg, 'image/png')
        );
        expect(mismatchResponse.status).toBe(415);
        await expect(mismatchResponse.json()).resolves.toMatchObject({
            code: 'OCR_MEDIA_TYPE_MISMATCH',
        });

        const corruptHarness = createHarness();
        const corruptJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
        const corruptResponse = await corruptHarness.handler(
            imageRequest(corruptJpeg, 'image/jpeg')
        );
        expect(corruptResponse.status).toBe(400);
        await expect(corruptResponse.json()).resolves.toMatchObject({ code: 'OCR_INVALID_IMAGE' });
        expect(mismatchedHarness.fetchImpl).not.toHaveBeenCalled();
        expect(corruptHarness.fetchImpl).not.toHaveBeenCalled();
    });

    it('enforces decoded image dimensions and pixel limits', async () => {
        const harness = createHarness({
            config: {
                ...BASE_CONFIG,
                imageLimits: { maxWidth: 3, maxHeight: 10, maxPixels: 100 },
            },
        });

        const response = await harness.handler(imageRequest(fixtures.png, 'image/png'));

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({ code: 'OCR_IMAGE_TOO_LARGE' });
        expect(harness.fetchImpl).not.toHaveBeenCalled();
    });

    it('does not read the request body or call Modal when quota validation fails', async () => {
        const consumeQuota = vi.fn().mockRejectedValue(new OcrProxyError(
            'OCR_QUOTA_EXCEEDED',
            429,
            'Quota OCR atteint.',
            { retryAfter: 31 }
        ));
        const harness = createHarness({ consumeQuota });
        const request = imageRequest(fixtures.jpeg, 'image/jpeg');

        const response = await harness.handler(request);

        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('31');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(request.bodyUsed).toBe(false);
        expect(harness.fetchImpl).not.toHaveBeenCalled();
    });

    it('fails closed before auth when the proxy is disabled or misconfigured', async () => {
        const disabled = createHarness({ env: { ...BASE_ENV, MODAL_OCR_ENABLED: 'false' } });
        const unconfigured = createHarness({
            env: { MODAL_OCR_ENABLED: 'true', MODAL_OCR_API_KEY: 'modal-secret' },
        });

        expect((await disabled.handler(imageRequest(fixtures.jpeg, 'image/jpeg'))).status).toBe(503);
        expect((await unconfigured.handler(imageRequest(fixtures.jpeg, 'image/jpeg'))).status).toBe(503);
        expect(disabled.authenticate).not.toHaveBeenCalled();
        expect(unconfigured.authenticate).not.toHaveBeenCalled();
    });
});

describe('createModalOcrHandler upstream isolation', () => {
    it('times out a request that never receives upstream headers', async () => {
        const fetchImpl = vi.fn((_url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
        }));
        const harness = createHarness({
            config: { ...BASE_CONFIG, timeoutMs: 10 },
            fetchImpl,
        });

        const response = await harness.handler(imageRequest(fixtures.jpeg, 'image/jpeg'));

        expect(response.status).toBe(504);
        await expect(response.json()).resolves.toMatchObject({ code: 'OCR_UPSTREAM_TIMEOUT' });
    });

    it('keeps the timeout active while streaming the upstream response body', async () => {
        const fetchImpl = vi.fn((_url, options) => {
            const body = new ReadableStream({
                start(controller) {
                    options.signal.addEventListener('abort', () => {
                        controller.error(new DOMException('aborted', 'AbortError'));
                    }, { once: true });
                },
            });
            return Promise.resolve(new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        });
        const harness = createHarness({
            config: { ...BASE_CONFIG, timeoutMs: 10 },
            fetchImpl,
        });

        const response = await harness.handler(imageRequest(fixtures.jpeg, 'image/jpeg'));

        expect(response.status).toBe(504);
        await expect(response.json()).resolves.toMatchObject({ code: 'OCR_UPSTREAM_TIMEOUT' });
    });

    it('never exposes a non-success upstream body', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(
            'modal-stacktrace-and-secret',
            { status: 500, headers: { 'Content-Type': 'text/plain' } }
        ));
        const harness = createHarness({ fetchImpl });

        const response = await harness.handler(imageRequest(fixtures.jpeg, 'image/jpeg'));
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body).toMatchObject({ code: 'OCR_UPSTREAM_ERROR' });
        expect(JSON.stringify(body)).not.toContain('modal-stacktrace-and-secret');
    });

    it.each([
        ['malformed JSON', new Response('{broken', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })],
        ['empty JSON body', new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })],
        ['oversized declared response', new Response('{}', {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': String((1024 * 1024) + 1),
            },
        })],
    ])('maps %s to a generic invalid-response error', async (_label, upstreamResponse) => {
        const harness = createHarness({
            fetchImpl: vi.fn().mockResolvedValue(upstreamResponse),
        });

        const response = await harness.handler(imageRequest(fixtures.jpeg, 'image/jpeg'));

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({
            code: 'OCR_UPSTREAM_INVALID_RESPONSE',
        });
    });

    it('normalizes bbox responses instead of forwarding arbitrary upstream fields', async () => {
        const upstreamPayload = {
            bubbles: [{ content: 'Bonjour', bbox: [1, 2, 3, 4], secret: 'discard-me' }],
            debug: 'discard-me-too',
        };
        const harness = createHarness({
            config: { ...BASE_CONFIG, responseKind: 'bubbles' },
            fetchImpl: vi.fn().mockResolvedValue(Response.json(upstreamPayload)),
        });

        const response = await harness.handler(imageRequest(fixtures.webp, 'image/webp'));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            bubbles: [{ content: 'Bonjour', bbox: [1, 2, 3, 4] }],
        });
    });
});
