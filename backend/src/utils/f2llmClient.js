const fs = require('fs');
const path = require('path');
const { getDefaultPrompt, getPromptContent } = require('./promptRegistry');

const DEFAULT_MODEL_DIR = path.resolve(__dirname, '../../models/f2llm-v2-160m-one-piece-retrieval');
const QUERY_PROMPT_KEY = 'embedding_query_f2llm';
const EXPECTED_DIM = 640;

let loadPromise = null;

function getModelDir() {
  return path.resolve(process.env.F2LLM_MODEL_PATH || DEFAULT_MODEL_DIR);
}

function ensureModelDir(modelDir) {
  const onnxPath = path.join(modelDir, 'onnx', 'model.onnx');
  if (!fs.existsSync(onnxPath)) {
    throw new Error(
      `F2LLM ONNX model not found at ${onnxPath}. Run backend/scripts/export_f2llm_onnx.py first or set F2LLM_MODEL_PATH.`
    );
  }
}

async function loadF2llm() {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const modelDir = getModelDir();
    ensureModelDir(modelDir);

    const { AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;

    const options = {
      local_files_only: true,
      dtype: process.env.F2LLM_DTYPE || 'fp32',
    };

    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelDir, options),
      AutoModel.from_pretrained(modelDir, options),
    ]);

    return { tokenizer, model, modelDir };
  })();

  return loadPromise;
}

function l2Normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

function lastTokenPool(lastHiddenState, attentionMask) {
  const [batchSize, sequenceLength, dimension] = lastHiddenState.dims;
  const hidden = lastHiddenState.data;
  const mask = attentionMask.data;
  const embeddings = [];

  for (let batch = 0; batch < batchSize; batch++) {
    let tokenCount = 0;
    for (let token = 0; token < sequenceLength; token++) {
      if (Number(mask[batch * sequenceLength + token]) > 0) tokenCount++;
    }

    const tokenIndex = Math.max(0, tokenCount - 1);
    const offset = (batch * sequenceLength + tokenIndex) * dimension;
    const vector = Array.from(hidden.slice(offset, offset + dimension), Number);
    embeddings.push(l2Normalize(vector));
  }

  return embeddings;
}

async function resolveQueryPrompt() {
  try {
    return await getPromptContent(QUERY_PROMPT_KEY);
  } catch {
    return getDefaultPrompt(QUERY_PROMPT_KEY).content;
  }
}

async function embedBatch(texts, inputType = 'document') {
  const cleanTexts = texts.map((text) => String(text || '').trim());
  if (cleanTexts.some((text) => !text)) {
    throw new Error('F2LLM embedding requires non-empty text.');
  }

  const { tokenizer, model } = await loadF2llm();
  let modelTexts = cleanTexts;
  if (inputType === 'query') {
    const queryPrompt = await resolveQueryPrompt();
    modelTexts = cleanTexts.map((text) => `${queryPrompt}${text}`);
  }

  const inputs = tokenizer(modelTexts, {
    padding: true,
    truncation: true,
  });
  const outputs = await model(inputs);
  const lastHiddenState = outputs.last_hidden_state || outputs.token_embeddings || outputs.logits;
  if (!lastHiddenState) {
    throw new Error('F2LLM model did not return last_hidden_state/token embeddings.');
  }

  const embeddings = lastTokenPool(lastHiddenState, inputs.attention_mask);
  for (const embedding of embeddings) {
    if (embedding.length !== EXPECTED_DIM) {
      throw new Error(`F2LLM embedding dimension mismatch: expected ${EXPECTED_DIM}, got ${embedding.length}.`);
    }
  }
  return embeddings;
}

async function generateF2llmEmbedding(text, inputType = 'document') {
  const [embedding] = await embedBatch([text], inputType);
  return embedding;
}

module.exports = {
  EXPECTED_DIM,
  generateF2llmEmbedding,
  embedBatch,
};
