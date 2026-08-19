import { AutoModel, Qwen2Tokenizer, env } from '@huggingface/transformers';
import { getPrompt } from '../lib/promptConfig';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = true;

const MODEL_PATH = 'models/f2llm-v2-160m-one-piece-retrieval';
const MODEL_PUBLIC_PATH = '/models/f2llm-v2-160m-one-piece-retrieval';
const EXPECTED_DIM = 640;

let model = null;
let tokenizer = null;
let device = null;
let loadingPromise = null;
const activeRequestIds = new Set();
const cancelledRequestIds = new Set();

env.localModelPath = `${self.location.origin}/`;

function publicModelUrl(filePath) {
    return new URL(`${MODEL_PUBLIC_PATH}/${filePath}`, self.location.origin).toString();
}

function normalize(vector) {
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    return vector.map(value => value / norm);
}

function poolLastToken(lastHiddenState, attentionMask) {
    const [batchSize, sequenceLength, hiddenSize] = lastHiddenState.dims;
    if (batchSize !== 1) throw new Error(`Batch inattendu: ${batchSize}`);
    if (hiddenSize !== EXPECTED_DIM) throw new Error(`Dimension F2LLM inattendue: ${hiddenSize}`);

    const hiddenData = lastHiddenState.data;
    const maskData = attentionMask.data;
    let lastTokenIndex = sequenceLength - 1;

    for (let i = sequenceLength - 1; i >= 0; i -= 1) {
        if (Number(maskData[i]) > 0) {
            lastTokenIndex = i;
            break;
        }
    }

    const offset = lastTokenIndex * hiddenSize;
    return normalize(Array.from(hiddenData.slice(offset, offset + hiddenSize)));
}

function progressCallback(data) {
    if (data.status !== 'progress') return;
    self.postMessage({
        status: 'download_progress',
        file: data.file,
        progress: data.progress || 0,
    });
}

async function loadWithDevice(selectedDevice) {
    const [tokenizerJSON, tokenizerConfig, loadedModel] = await Promise.all([
        fetch(publicModelUrl('tokenizer.json')).then(response => {
            if (!response.ok) throw new Error(`tokenizer.json introuvable (${response.status})`);
            return response.json();
        }),
        fetch(publicModelUrl('tokenizer_config.json')).then(response => {
            if (!response.ok) throw new Error(`tokenizer_config.json introuvable (${response.status})`);
            return response.json();
        }),
        AutoModel.from_pretrained(MODEL_PATH, {
            dtype: 'fp32',
            device: selectedDevice,
            model_file_name: 'model',
            progress_callback: progressCallback,
        }),
    ]);

    tokenizer = new Qwen2Tokenizer(tokenizerJSON, tokenizerConfig);
    model = loadedModel;
    device = selectedDevice;
}

async function ensureLoaded() {
    if (model && tokenizer) return;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        const preferredDevices = self.navigator?.gpu ? ['webgpu', 'wasm'] : ['wasm'];
        let lastError = null;

        for (const selectedDevice of preferredDevices) {
            try {
                await loadWithDevice(selectedDevice);
                self.postMessage({ status: 'ready', device });
                return;
            } catch (err) {
                lastError = err;
                model = null;
                tokenizer = null;
                device = null;
            }
        }

        throw lastError || new Error('Chargement F2LLM impossible');
    })().finally(() => {
        loadingPromise = null;
    });

    return loadingPromise;
}

async function embedQuery(text) {
    await ensureLoaded();
    const queryPrompt = await getPrompt('embedding_query_f2llm');
    const inputs = await tokenizer(`${queryPrompt}${text}`, {
        padding: true,
        truncation: true,
        max_length: 512,
    });
    const outputs = await model(inputs);
    const lastHiddenState = outputs.last_hidden_state || outputs.hidden_states;
    if (!lastHiddenState) throw new Error('Sortie last_hidden_state absente');
    return poolLastToken(lastHiddenState, inputs.attention_mask);
}

self.addEventListener('message', async (event) => {
    const { type, requestId, text } = event.data || {};

    if (type === 'cancel') {
        if (activeRequestIds.has(requestId)) cancelledRequestIds.add(requestId);
        return;
    }

    try {
        if (type === 'init') {
            await ensureLoaded();
            self.postMessage({ status: 'ready', requestId, device });
            return;
        }

        if (type === 'embed') {
            if (!text || text.trim().length < 2) {
                throw new Error('Recherche trop courte');
            }

            activeRequestIds.add(requestId);
            const embedding = await embedQuery(text.trim());
            if (cancelledRequestIds.has(requestId)) return;
            self.postMessage({ status: 'complete', requestId, embedding, device });
        }
    } catch (err) {
        if (cancelledRequestIds.has(requestId)) return;
        const error = err instanceof Error ? err.message : String(err);
        self.postMessage({ status: 'error', requestId, error });
    } finally {
        if (type === 'embed') {
            activeRequestIds.delete(requestId);
            cancelledRequestIds.delete(requestId);
        }
    }
});
