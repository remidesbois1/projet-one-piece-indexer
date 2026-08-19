import { getAiModelConfig } from './aiModelConfig';

const CHATGPT_AUTH_EVENT = 'poneglyph:chatgpt-auth-changed';

async function resolveDesktopInvoke() {
    if (typeof window === 'undefined') return null;
    const { invoke, isTauri } = await import('@tauri-apps/api/core');
    if (isTauri() || window.__TAURI_INTERNALS__) return invoke;
    return null;
}

async function invokeDesktop(command, args = {}) {
    const invoke = await resolveDesktopInvoke();
    if (invoke) return invoke(command, args);
    throw new Error('Commande disponible uniquement dans Poneglyph Desktop.');
}

function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return window.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function createPkce() {
    const verifierBytes = new Uint8Array(64);
    const stateBytes = new Uint8Array(32);
    window.crypto.getRandomValues(verifierBytes);
    window.crypto.getRandomValues(stateBytes);
    const codeVerifier = base64Url(verifierBytes);
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    return {
        code_verifier: codeVerifier,
        code_challenge: base64Url(new Uint8Array(digest)),
        oauth_state: base64Url(stateBytes),
    };
}

async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return window.btoa(binary);
}

export async function getChatGptStatus() {
    try {
        const status = await invokeDesktop('get_chatgpt_auth_status');
        return { available: true, ...status };
    } catch {
        return { available: false, connected: false, model: 'gpt-5.6-luna' };
    }
}

export async function loginChatGpt() {
    const status = await invokeDesktop('chatgpt_login', await createPkce());
    window.dispatchEvent(new CustomEvent(CHATGPT_AUTH_EVENT, { detail: status }));
    return { available: true, ...status };
}

export async function logoutChatGpt() {
    const status = await invokeDesktop('chatgpt_logout');
    window.dispatchEvent(new CustomEvent(CHATGPT_AUTH_EVENT, { detail: status }));
    return { available: true, ...status };
}

export async function runChatGptPageOcr(imageBlob, options = {}) {
    if (!(imageBlob instanceof Blob)) throw new Error('Image OCR manquante.');
    const config = await getAiModelConfig();
    const model = options.model || config.model_chatgpt_ocr;
    const fastMode = options.fastMode ?? config.chatgpt_fast_mode;
    return invokeDesktop('run_chatgpt_page_ocr', {
        image_bytes_base64: await blobToBase64(imageBlob),
        mime_type: imageBlob.type || 'image/jpeg',
        model,
        fast_mode: Boolean(fastMode),
    });
}

export function subscribeToChatGptAuth(listener) {
    const handler = (event) => listener(event.detail);
    window.addEventListener(CHATGPT_AUTH_EVENT, handler);
    return () => window.removeEventListener(CHATGPT_AUTH_EVENT, handler);
}
