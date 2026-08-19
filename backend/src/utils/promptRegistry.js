const llmPromptDefaults = require('@poneglyph/shared/llm-prompts.json');
const { supabaseAdmin } = require('../config/supabaseClient');

const PROMPT_CONTENT_MAX_LENGTH = 20000;

const DEFAULT_PROMPTS = new Map(llmPromptDefaults.map((prompt) => [prompt.key, { ...prompt }]));
const PROMPT_KEYS = new Set(DEFAULT_PROMPTS.keys());

let promptsCache = null;
let promptsCacheTime = 0;
const PROMPTS_CACHE_TTL = 60 * 1000;

function getDefaultPrompt(key) {
  return DEFAULT_PROMPTS.get(key) || null;
}

function mergePromptRows(rows) {
  const merged = new Map(DEFAULT_PROMPTS);
  for (const row of rows || []) {
    if (!PROMPT_KEYS.has(row.key)) continue;
    const fallback = merged.get(row.key);
    merged.set(row.key, {
      ...fallback,
      label: row.label || fallback.label,
      category: row.category || fallback.category,
      description: row.description ?? fallback.description,
      content: typeof row.content === 'string' && row.content.trim() ? row.content : fallback.content,
      updated_at: row.updated_at || null,
      is_default: row.content === fallback.content,
    });
  }
  return merged;
}

async function loadPromptRows() {
  const { data, error } = await supabaseAdmin
    .from('llm_prompts')
    .select('key, label, category, description, content, updated_at');

  if (error) throw error;
  return data;
}

async function getPromptRegistry() {
  const now = Date.now();
  if (promptsCache && (now - promptsCacheTime) < PROMPTS_CACHE_TTL) {
    return promptsCache;
  }

  const merged = mergePromptRows(await loadPromptRows());
  promptsCache = merged;
  promptsCacheTime = now;
  return merged;
}

async function getPromptContent(key) {
  if (!PROMPT_KEYS.has(key)) {
    throw new Error(`Unknown LLM prompt key: ${key}`);
  }
  const registry = await getPromptRegistry();
  return registry.get(key).content;
}

async function getPromptContents() {
  const registry = await getPromptRegistry();
  const contents = {};
  for (const [key, prompt] of registry) {
    contents[key] = prompt.content;
  }
  return contents;
}

function invalidatePromptCache() {
  promptsCache = null;
  promptsCacheTime = 0;
}

module.exports = {
  PROMPT_KEYS,
  PROMPT_CONTENT_MAX_LENGTH,
  getDefaultPrompt,
  getPromptRegistry,
  getPromptContent,
  getPromptContents,
  invalidatePromptCache,
};
