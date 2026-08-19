const COOKIE_NAME = 'ai_models';
const COOKIE_TTL = 5 * 60 * 1000;
const AI_MODEL_CONFIG_EVENT = 'poneglyph:ai-model-config-changed';

export const DEFAULT_AI_MODEL_CONFIG = Object.freeze({
    model_ocr: 'gemini-2.5-flash-lite',
    model_description: 'gemini-3-flash-preview',
    model_chatgpt_ocr: 'gpt-5.6-luna',
    gemini_thinking_level: 'default',
    chatgpt_reasoning_effort: 'low',
    chatgpt_fast_mode: false,
});

function normalizeConfig(config) {
    return {
        ...DEFAULT_AI_MODEL_CONFIG,
        ...(config || {}),
        chatgpt_fast_mode: config?.chatgpt_fast_mode === true || config?.chatgpt_fast_mode === 'true',
    };
}

function getCachedModels() {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
    if (!match) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(match[1]));
        return parsed._ts && (Date.now() - parsed._ts) < COOKIE_TTL ? normalizeConfig(parsed) : null;
    } catch {
        return null;
    }
}

export function cacheAiModelConfig(config) {
    const normalized = normalizeConfig(config);
    if (typeof document !== 'undefined') {
        const payload = { ...normalized, _ts: Date.now() };
        document.cookie = `${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(payload))}; path=/; max-age=${COOKIE_TTL / 1000}; SameSite=Lax`;
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(AI_MODEL_CONFIG_EVENT, { detail: normalized }));
    }
    return normalized;
}

export async function getAiModelConfig() {
    const cached = getCachedModels();
    if (cached) return cached;

    try {
        const { getPublicAiModels } = await import('./api');
        return cacheAiModelConfig((await getPublicAiModels()).data);
    } catch {
        return normalizeConfig(DEFAULT_AI_MODEL_CONFIG);
    }
}

export function invalidateModelCache() {
    if (typeof document !== 'undefined') {
        document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
    }
}

export function subscribeToAiModelConfig(listener) {
    const handler = (event) => listener(normalizeConfig(event.detail));
    window.addEventListener(AI_MODEL_CONFIG_EVENT, handler);
    return () => window.removeEventListener(AI_MODEL_CONFIG_EVENT, handler);
}
