import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = false;

let pipe = null;

const MODEL_ID = 'Remidesbois/trocr-manga-fr-printed';

function fixPunctuation(text) {
    return text
        .replace(/([A-Za-zÀ-ÿ])([!?:;]+)/g, '$1 $2')
        .replace(/([!?:;]+)(?=[A-Za-zÀ-ÿ])/g, '$1 ')
        .replace(/([.,…]+)(?=[A-Za-zÀ-ÿ])/g, '$1 ')
        .replace(/ +/g, ' ')
        .trim();
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            if (pipe) {
                self.postMessage({ status: 'ready' });
                return;
            }

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            console.log("[Worker] Chargement de TrOCR Manga FR (WebGPU)...");

            pipe = await pipeline('image-to-text', MODEL_ID, {
                dtype: 'fp32',
                device: 'webgpu',
                progress_callback: progressCallback,
            });

            console.log("[Worker] Modèle TrOCR chargé et prêt.");
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker Init Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Initialisation impossible : ${errorMsg}` });
        }
    }

    if (type === 'run' && imageBlob) {
        const { requestId } = event.data;
        if (!pipe) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé.', requestId });
            return;
        }

        try {
            const debugURL = URL.createObjectURL(imageBlob);
            self.postMessage({ status: 'debug_image', url: debugURL, requestId });

            const imageURL = URL.createObjectURL(imageBlob);

            const output = await pipe(imageURL, {
                max_new_tokens: 512,
                num_beams: 5,
                repetition_penalty: 1.2,
                do_sample: false,
            });

            URL.revokeObjectURL(imageURL);

            const raw = output?.[0]?.generated_text?.trim() || '';
            const text = fixPunctuation(raw);
            console.log("[Worker] Texte extrait :", text);

            self.postMessage({ status: 'complete', text, requestId });
        } catch (err) {
            console.error("[Worker Run Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Erreur OCR : ${errorMsg}`, requestId });
        }
    }
});