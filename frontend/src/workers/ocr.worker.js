import { AutoProcessor, AutoTokenizer, AutoModelForVision2Seq, RawImage, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

let model = null;
let processor = null;
let tokenizer = null;

const MODEL_ID = 'Remidesbois/trocr-onepiece-fr';

function fixFrenchPunctuation(text) {
    text = text.replace(/\s+([!?;:])/g, ' $1');
    text = text.replace(/([^\s])([!?;:])/g, '$1 $2');
    text = text.replace(/([!?])\s+([!?])/g, '$1$2');
    text = text.replace(/\s+/g, ' ');
    return text.trim();
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            if (model && processor && tokenizer) {
                self.postMessage({ status: 'ready' });
                return;
            }

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            console.log("[Worker] Chargement de TrOCR (fp32, WebGPU)...");

            [model, processor, tokenizer] = await Promise.all([
                AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
                    dtype: 'fp32',
                    device: 'webgpu',
                    progress_callback: progressCallback
                }),
                AutoProcessor.from_pretrained(MODEL_ID, {
                    progress_callback: progressCallback
                }),
                AutoTokenizer.from_pretrained(MODEL_ID, {
                    progress_callback: progressCallback
                })
            ]);

            console.log("[Worker] Modèle chargé et prêt.");
            self.postMessage({ status: 'ready' });
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
            const image = await RawImage.fromBlob(imageBlob);
            const inputs = await processor(image);

            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: 64,
                num_beams: 6,
                repetition_penalty: 1.2,
                no_repeat_ngram_size: 3,
                length_penalty: 2.0,
                early_stopping: true,
                decoder_start_token_id: 0,
                eos_token_id: 2,
                pad_token_id: 1,
            });

            const raw = tokenizer.batch_decode(generatedIds, {
                skip_special_tokens: true,
            })[0].trim();

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
