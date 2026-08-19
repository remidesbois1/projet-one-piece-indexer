import defaultPrompts from '@poneglyph/shared/llm-prompts.json';

const STORAGE_KEY = 'poneglyph:llm-prompts';
const STORAGE_TTL = 5 * 60 * 1000;
const PROMPT_CONFIG_EVENT = 'poneglyph:llm-prompts-changed';

export const DEFAULT_PROMPTS = Object.freeze(
    Object.fromEntries(defaultPrompts.map((prompt) => [prompt.key, prompt.content]))
);

export const PROMPT_METADATA = Object.freeze(
    Object.fromEntries(defaultPrompts.map(({ key, label, category, description }) => [key, { label, category, description }]))
);

function normalizeContents(contents) {
    const merged = { ...DEFAULT_PROMPTS };
    for (const [key, content] of Object.entries(contents || {})) {
        if (key in DEFAULT_PROMPTS && typeof content === 'string' && content.trim()) {
            merged[key] = content;
        }
    }
    return merged;
}

function getCachedContents() {
    if (typeof window === 'undefined') return null;
    try {
        const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
        return parsed._ts && (Date.now() - parsed._ts) < STORAGE_TTL ? normalizeContents(parsed) : null;
    } catch {
        return null;
    }
}

export function cachePromptContents(contents) {
    const normalized = normalizeContents(contents);
    if (typeof window !== 'undefined') {
        const payload = { ...normalized, _ts: Date.now() };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(PROMPT_CONFIG_EVENT, { detail: normalized }));
    }
    return normalized;
}

export async function getPromptContents() {
    const cached = getCachedContents();
    if (cached) return cached;

    try {
        const { getPublicPrompts } = await import('./api');
        return cachePromptContents((await getPublicPrompts()).data);
    } catch {
        return normalizeContents(DEFAULT_PROMPTS);
    }
}

export async function getPrompt(key) {
    const contents = await getPromptContents();
    if (!(key in contents)) {
        throw new Error(`Prompt inconnu : ${key}`);
    }
    return contents[key];
}

export function invalidatePromptCache() {
    if (typeof window !== 'undefined') {
        window.localStorage.removeItem(STORAGE_KEY);
    }
}

export function subscribeToPromptContents(listener) {
    const handler = (event) => listener(normalizeContents(event.detail));
    window.addEventListener(PROMPT_CONFIG_EVENT, handler);
    return () => window.removeEventListener(PROMPT_CONFIG_EVENT, handler);
}
