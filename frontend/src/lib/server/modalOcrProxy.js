import sharp from 'sharp';
import {
    assertOcrProxyEnabled,
    authenticateOcrRequest,
    consumePersistentOcrQuota,
    OcrProxyError,
} from './modalOcrSecurity';

const DEFAULT_IMAGE_LIMITS = Object.freeze({
    maxBytes: 10 * 1024 * 1024,
    maxWidth: 6000,
    maxHeight: 6000,
    maxPixels: 24_000_000,
});
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const ALLOWED_IMAGE_TYPES = Object.freeze({
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
});
const NO_STORE_HEADERS = Object.freeze({
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
});

function jsonResponse(body, status, extraHeaders = {}) {
    return Response.json(body, {
        status,
        headers: { ...NO_STORE_HEADERS, ...extraHeaders },
    });
}

function toErrorResponse(error) {
    if (error instanceof OcrProxyError) {
        const headers = error.retryAfter
            ? { 'Retry-After': String(error.retryAfter) }
            : {};
        return jsonResponse({ error: error.message, code: error.code }, error.status, headers);
    }

    return jsonResponse(
        { error: 'Service OCR indisponible.', code: 'OCR_INTERNAL_ERROR' },
        500
    );
}

function parseContentType(request) {
    const encoding = request.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
        throw new OcrProxyError('OCR_UNSUPPORTED_ENCODING', 415, 'Format d\'image non pris en charge.');
    }

    const contentType = (request.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (!ALLOWED_IMAGE_TYPES[contentType]) {
        throw new OcrProxyError('OCR_UNSUPPORTED_MEDIA_TYPE', 415, 'Format d\'image non pris en charge.');
    }
    return contentType;
}

function parseContentLength(headers, maxBytes, createLimitError, createInvalidError) {
    const rawLength = headers.get('content-length');
    if (rawLength === null) return null;
    if (!/^\d+$/.test(rawLength)) {
        throw createInvalidError();
    }

    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        throw createInvalidError();
    }
    if (contentLength > maxBytes) throw createLimitError();
    return contentLength;
}

async function readStreamWithLimit(stream, maxBytes, createLimitError, createEmptyError) {
    if (!stream) throw createEmptyError();

    const reader = stream.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;

            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    // The request is already rejected; cancellation is best effort.
                }
                throw createLimitError();
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    if (totalBytes === 0) throw createEmptyError();
    return Buffer.concat(chunks, totalBytes);
}

function detectImageFormat(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'jpeg';
    }
    if (
        buffer.length >= 8
        && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        return 'png';
    }
    if (
        buffer.length >= 12
        && buffer.toString('ascii', 0, 4) === 'RIFF'
        && buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'webp';
    }
    return null;
}

export async function inspectOcrImage(buffer, contentType, limits = DEFAULT_IMAGE_LIMITS) {
    const magicFormat = detectImageFormat(buffer);
    if (!magicFormat || ALLOWED_IMAGE_TYPES[contentType] !== magicFormat) {
        throw new OcrProxyError('OCR_MEDIA_TYPE_MISMATCH', 415, 'Format d\'image non pris en charge.');
    }

    let metadata;
    try {
        metadata = await sharp(buffer, {
            animated: false,
            failOn: 'warning',
            limitInputPixels: limits.maxPixels,
            sequentialRead: true,
        }).metadata();
    } catch (error) {
        if (/pixel limit|input image exceeds/i.test(error?.message || '')) {
            throw new OcrProxyError('OCR_IMAGE_TOO_LARGE', 413, 'Image trop grande.');
        }
        throw new OcrProxyError('OCR_INVALID_IMAGE', 400, 'Image invalide.');
    }

    const width = Number(metadata.width);
    const height = Number(metadata.height);
    const pages = Number(metadata.pages || 1);
    if (
        metadata.format !== magicFormat
        || !Number.isSafeInteger(width) || width <= 0
        || !Number.isSafeInteger(height) || height <= 0
    ) {
        throw new OcrProxyError('OCR_INVALID_IMAGE', 400, 'Image invalide.');
    }
    if (pages !== 1) {
        throw new OcrProxyError('OCR_ANIMATED_IMAGE', 415, 'Les images animées ne sont pas acceptées.');
    }
    if (
        width > limits.maxWidth
        || height > limits.maxHeight
        || width * height > limits.maxPixels
    ) {
        throw new OcrProxyError('OCR_IMAGE_TOO_LARGE', 413, 'Image trop grande.');
    }

    return { width, height, pixels: width * height, format: magicFormat };
}

function getUpstreamConfiguration(env, config) {
    const modalUrl = env[config.urlEnv];
    const modalApiKey = env.MODAL_OCR_API_KEY;
    if (!modalUrl || !modalApiKey) {
        throw new OcrProxyError('OCR_CONFIGURATION_ERROR', 503, 'Service OCR indisponible.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(modalUrl);
    } catch {
        throw new OcrProxyError('OCR_CONFIGURATION_ERROR', 503, 'Service OCR indisponible.');
    }
    if (parsedUrl.protocol !== 'https:') {
        throw new OcrProxyError('OCR_CONFIGURATION_ERROR', 503, 'Service OCR indisponible.');
    }

    return { modalUrl: parsedUrl.toString(), modalApiKey };
}

function normalizeModalPayload(payload, responseKind) {
    if (!payload || typeof payload !== 'object' || payload.error) {
        throw new OcrProxyError('OCR_UPSTREAM_INVALID_RESPONSE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
    }

    if (responseKind === 'text') {
        if (typeof payload.text !== 'string' || payload.text.length > 100_000) {
            throw new OcrProxyError('OCR_UPSTREAM_INVALID_RESPONSE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
        }
        return { text: payload.text };
    }

    if (responseKind === 'bubbles') {
        if (!Array.isArray(payload.bubbles) || payload.bubbles.length > 1000) {
            throw new OcrProxyError('OCR_UPSTREAM_INVALID_RESPONSE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
        }
        const valid = payload.bubbles.every((bubble) => (
            bubble
            && typeof bubble.content === 'string'
            && bubble.content.length <= 10_000
            && Array.isArray(bubble.bbox)
            && bubble.bbox.length === 4
            && bubble.bbox.every(Number.isFinite)
        ));
        if (!valid) {
            throw new OcrProxyError('OCR_UPSTREAM_INVALID_RESPONSE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
        }
        return {
            bubbles: payload.bubbles.map((bubble) => ({
                content: bubble.content,
                bbox: [...bubble.bbox],
            })),
        };
    }

    throw new OcrProxyError('OCR_CONFIGURATION_ERROR', 503, 'Service OCR indisponible.');
}

async function readModalJson(response) {
    if (!response.ok) {
        try {
            await response.body?.cancel();
        } catch {
            // The upstream body is intentionally discarded and never exposed.
        }
        throw new OcrProxyError('OCR_UPSTREAM_ERROR', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
    }

    const responseType = (response.headers.get('content-type') || '').toLowerCase();
    if (!responseType.includes('application/json')) {
        throw new OcrProxyError('OCR_UPSTREAM_INVALID_RESPONSE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
    }

    const createInvalidResponseError = () => new OcrProxyError(
        'OCR_UPSTREAM_INVALID_RESPONSE',
        502,
        'Le service OCR n\'a pas pu traiter l\'image.'
    );
    parseContentLength(
        response.headers,
        MAX_UPSTREAM_BYTES,
        createInvalidResponseError,
        createInvalidResponseError
    );
    const responseBuffer = await readStreamWithLimit(
        response.body,
        MAX_UPSTREAM_BYTES,
        createInvalidResponseError,
        createInvalidResponseError
    );

    try {
        return JSON.parse(responseBuffer.toString('utf8'));
    } catch {
        throw new OcrProxyError('OCR_UPSTREAM_INVALID_RESPONSE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
    }
}

export function createModalOcrHandler(config, dependencies = {}) {
    const env = dependencies.env || process.env;
    const authenticate = dependencies.authenticate || authenticateOcrRequest;
    const consumeQuota = dependencies.consumeQuota || consumePersistentOcrQuota;
    const inspectImage = dependencies.inspectImage || inspectOcrImage;
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    const imageLimits = { ...DEFAULT_IMAGE_LIMITS, ...config.imageLimits };

    return async function handleModalOcr(request) {
        try {
            assertOcrProxyEnabled(env);
            const { modalUrl, modalApiKey } = getUpstreamConfiguration(env, config);
            const contentType = parseContentType(request);
            parseContentLength(
                request.headers,
                imageLimits.maxBytes,
                () => new OcrProxyError('OCR_BODY_TOO_LARGE', 413, 'Image trop volumineuse.'),
                () => new OcrProxyError('OCR_INVALID_BODY', 400, 'Image invalide.')
            );

            const identity = await authenticate(request, {
                env,
                allowAnonymous: config.allowAnonymous === true,
            });
            await consumeQuota({
                request,
                userId: identity.userId,
                isAnonymous: identity.isAnonymous,
                cost: config.quotaCost,
            }, { env });

            const imageBuffer = await readStreamWithLimit(
                request.body,
                imageLimits.maxBytes,
                () => new OcrProxyError('OCR_BODY_TOO_LARGE', 413, 'Image trop volumineuse.'),
                () => new OcrProxyError('OCR_EMPTY_BODY', 400, 'Image requise.')
            );
            await inspectImage(imageBuffer, contentType, imageLimits);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
            let payload;
            try {
                const modalResponse = await fetchImpl(modalUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Length': String(imageBuffer.byteLength),
                        'Content-Type': contentType,
                        'X-API-Key': modalApiKey,
                    },
                    body: imageBuffer,
                    cache: 'no-store',
                    signal: controller.signal,
                });
                payload = await readModalJson(modalResponse);
            } catch (error) {
                if (error instanceof OcrProxyError) throw error;
                if (controller.signal.aborted) {
                    throw new OcrProxyError('OCR_UPSTREAM_TIMEOUT', 504, 'Le service OCR a mis trop de temps à répondre.');
                }
                throw new OcrProxyError('OCR_UPSTREAM_UNAVAILABLE', 502, 'Le service OCR n\'a pas pu traiter l\'image.');
            } finally {
                clearTimeout(timeout);
            }

            const normalizedPayload = normalizeModalPayload(payload, config.responseKind);
            return jsonResponse(normalizedPayload, 200);
        } catch (error) {
            if (!(error instanceof OcrProxyError)) {
                console.error('[Modal OCR proxy]', {
                    route: config.id,
                    error: error instanceof Error ? error.name : 'UnknownError',
                });
            }
            return toErrorResponse(error);
        }
    };
}
