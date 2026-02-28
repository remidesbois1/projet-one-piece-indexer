import { AutoProcessor, AutoTokenizer, AutoModelForVision2Seq, RawImage, env } from '@huggingface/transformers';
import { fixFrenchPunctuation, joinLines, splitIntoLines, cropLineFromBlob, getImageInfo } from '../lib/ocr-utils.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let model = null;
let processor = null;
let tokenizer = null;
let currentModelId = null;

const MODELS = {
    base: {
        id: 'Remidesbois/trocr-onepiece-fr',
        splitLines: false,
        genConfig: {
            max_new_tokens: 64,
            num_beams: 4,
            repetition_penalty: 1.2,
            no_repeat_ngram_size: 0,
            length_penalty: 1.0,
            early_stopping: true,
            decoder_start_token_id: 0,
            eos_token_id: 2,
            pad_token_id: 1,
        }
    },
    large: {
        id: 'Remidesbois/trocr-onepiece-fr-large',
        splitLines: true,
        genConfig: {
            max_new_tokens: 64,
            num_beams: 4,
            repetition_penalty: 1.2,
            no_repeat_ngram_size: 0,
            length_penalty: 1.0,
            early_stopping: true,
            decoder_start_token_id: 0,
            eos_token_id: 2,
            pad_token_id: 1,
        }
    }
};

async function ocrSingleImage(imageBlob, genConfig) {
    const image = await RawImage.fromBlob(imageBlob);
    const inputs = await processor(image);

    const generatedIds = await model.generate({
        ...inputs,
        ...genConfig,
    });

    return tokenizer.batch_decode(generatedIds, {
        skip_special_tokens: true,
    })[0].trim();
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob, modelKey } = event.data;

    if (type === 'init') {
        try {
            const selectedKey = modelKey || 'base';
            const selectedModel = MODELS[selectedKey];

            if (!selectedModel) {
                self.postMessage({ status: 'error', error: `Modèle inconnu: ${selectedKey}` });
                return;
            }

            if (model && processor && tokenizer && currentModelId === selectedModel.id) {
                self.postMessage({ status: 'ready', modelKey: selectedKey });
                return;
            }

            if (currentModelId && currentModelId !== selectedModel.id) {
                model = null;
                processor = null;
                tokenizer = null;
                currentModelId = null;
            }

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            console.log(`[Worker] Chargement de ${selectedModel.id} (fp32, WebGPU)...`);

            [model, processor, tokenizer] = await Promise.all([
                AutoModelForVision2Seq.from_pretrained(selectedModel.id, {
                    dtype: 'fp32',
                    device: 'webgpu',
                    progress_callback: progressCallback
                }),
                AutoProcessor.from_pretrained(selectedModel.id, {
                    progress_callback: progressCallback
                }),
                AutoTokenizer.from_pretrained(selectedModel.id, {
                    progress_callback: progressCallback
                })
            ]);

            currentModelId = selectedModel.id;
            console.log(`[Worker] Modèle ${selectedKey} chargé et prêt.`);
            self.postMessage({ status: 'ready', modelKey: selectedKey });
        } catch (err) {
            console.error("[Worker Init Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Initialisation impossible : ${errorMsg}` });
        }
    }

    if (type === 'run' && imageBlob) {
        const { requestId } = event.data;
        if (!model || !processor || !tokenizer) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé.', requestId });
            return;
        }

        try {
            const activeKey = Object.keys(MODELS).find(k => MODELS[k].id === currentModelId) || 'base';
            const activeModel = MODELS[activeKey];
            const genConfig = activeModel.genConfig;

            let raw;
            if (activeModel.splitLines) {
                const { width, height, data } = await getImageInfo(imageBlob);
                const lines = splitIntoLines(data, width, height);

                if (lines && lines.length > 1) {
                    console.log(`[Worker] ${lines.length} lignes détectées, OCR ligne par ligne`);
                    const lineTexts = [];
                    for (const lineRegion of lines) {
                        const lineBlob = await cropLineFromBlob(imageBlob, lineRegion, width);
                        const lineText = await ocrSingleImage(lineBlob, genConfig);
                        if (lineText) lineTexts.push(lineText);
                    }
                    raw = joinLines(lineTexts);
                } else {
                    raw = await ocrSingleImage(imageBlob, genConfig);
                }
            } else {
                raw = await ocrSingleImage(imageBlob, genConfig);
            }

            const text = fixFrenchPunctuation(raw);

            console.log("[Worker] OCR result:", text);
            self.postMessage({ status: 'complete', text, requestId });

        } catch (err) {
            console.error("[Worker Run Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Erreur OCR : ${errorMsg}`, requestId });
        }
    }
});
