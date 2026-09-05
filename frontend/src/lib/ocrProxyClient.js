import { supabase } from './supabaseClient';

const DEVICE_STORAGE_KEY = 'poneglyph_ocr_device_id';
const ALLOWED_ENDPOINTS = new Set([
    '/api/ocr',
    '/api/local_lighton',
    '/api/poneglyph_one_shot',
]);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

let memoryDeviceId = null;

export class OcrClientError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'OcrClientError';
        this.code = code;
    }
}

function createDeviceId() {
    const browserCrypto = globalThis.crypto;
    if (!browserCrypto) {
        throw new OcrClientError('OCR_DEVICE_ID_UNAVAILABLE', 'Le service OCR est indisponible.');
    }
    if (typeof browserCrypto.randomUUID === 'function') {
        return browserCrypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function isValidDeviceId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

export function getOcrDeviceId() {
    if (memoryDeviceId) return memoryDeviceId;

    try {
        const storedId = globalThis.localStorage?.getItem(DEVICE_STORAGE_KEY);
        if (isValidDeviceId(storedId)) {
            memoryDeviceId = storedId;
            return storedId;
        }
    } catch {
        // Private browsing and hardened browser policies may deny storage access.
    }

    memoryDeviceId = createDeviceId();
    try {
        globalThis.localStorage?.setItem(DEVICE_STORAGE_KEY, memoryDeviceId);
    } catch {
        // The in-memory identifier still provides a per-tab quota subject.
    }
    return memoryDeviceId;
}

export async function postOcrImage(endpoint, imageBlob, options = {}) {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
        throw new OcrClientError('OCR_INVALID_ENDPOINT', 'Le service OCR est indisponible.');
    }
    if (!(imageBlob instanceof Blob) || !ALLOWED_IMAGE_TYPES.has(imageBlob.type)) {
        throw new OcrClientError('OCR_INVALID_IMAGE', 'Image invalide.');
    }
    const authClient = options.authClient || supabase;
    let sessionResult;
    try {
        sessionResult = await authClient.auth.getSession();
    } catch {
        throw new OcrClientError('OCR_AUTH_UNAVAILABLE', 'Impossible de vérifier la session.');
    }

    if (
        sessionResult?.error
        || !sessionResult?.data
        || !Object.prototype.hasOwnProperty.call(sessionResult.data, 'session')
    ) {
        throw new OcrClientError('OCR_AUTH_UNAVAILABLE', 'Impossible de vérifier la session.');
    }
    const token = sessionResult.data.session?.access_token;
    if (!token) {
        throw new OcrClientError('OCR_AUTH_REQUIRED', 'Connectez-vous pour utiliser ce service OCR.');
    }

    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const headers = {
        'Content-Type': imageBlob.type,
        'X-OCR-Device-Id': getOcrDeviceId(),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    return fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: imageBlob,
        cache: 'no-store',
        credentials: 'same-origin',
    });
}
