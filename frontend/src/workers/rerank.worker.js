import { AutoTokenizer, AutoModelForSequenceClassification, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

let model = null;
let tokenizer = null;

const MODEL_ID = 'mixedbread-ai/mxbai-rerank-base-v1';

self.addEventListener('message', async (event) => {
    const { type, query, documents, modelId } = event.data;

    if (type === 'init') {
        try {
            if (model && tokenizer) {
                self.postMessage({ status: 'ready' });
                return;
            }

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            console.log(`[Rerank Worker] Loading model ${MODEL_ID}...`);

            model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
                quantized: true,
                device: 'webgpu',
                dtype: 'fp32',
                progress_callback: progressCallback
            });

            tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
                progress_callback: progressCallback
            });

            console.log("[Rerank Worker] Model loaded.");
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Rerank Worker Init Error]", err);
            const msg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: msg });
        }
    }

    if (type === 'rerank') {
        if (!model || !tokenizer) {
            self.postMessage({ status: 'error', error: 'Model not loaded' });
            return;
        }

        try {
            const queries = [];
            const texts = [];

            documents.forEach(doc => {
                let text = "";
                if (typeof doc === 'string') {
                    text = doc;
                } else if (doc && typeof doc === 'object') {
                    text = doc.ocr_text || doc.description || doc.content || doc.text || "";
                    if (!text) text = JSON.stringify(doc);
                } else {
                    text = String(doc);
                }

                if (typeof text !== 'string') text = String(text);

                queries.push(String(query || ""));
                texts.push(text);
            });

            const inputs = await tokenizer(queries, {
                text_pair: texts,
                padding: true,
                truncation: true,
            });

            const { logits } = await model(inputs);
            const scores = logits.sigmoid().data;

            const rankedResults = documents.map((doc, index) => {
                return {
                    doc,
                    index,
                    score: scores[index]
                };
            }).sort((a, b) => b.score - a.score);

            self.postMessage({ status: 'complete', results: rankedResults });

        } catch (err) {
            console.error("[Rerank Worker Run Error]", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }
});
