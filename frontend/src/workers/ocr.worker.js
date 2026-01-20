import { AutoProcessor, Florence2ForConditionalGeneration, RawImage, env } from '@huggingface/transformers';

// Configuration
env.allowLocalModels = false;
env.useBrowserCache = true;

let model = null;
let processor = null;

const MODEL_ID = 'onnx-community/Florence-2-base-ft';

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    // --- INITIALISATION DU MODÈLE ---
    if (type === 'init') {
        try {
            if (model && processor) {
                self.postMessage({ status: 'ready' });
                return;
            }

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            console.log("[Worker] Chargement de Florence-2 (fp32)...");

            model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
                dtype: 'fp32',
                device: 'webgpu',
                progress_callback: progressCallback
            });

            processor = await AutoProcessor.from_pretrained(MODEL_ID, {
                progress_callback: progressCallback
            });

            console.log("[Worker] Modèle chargé et prêt.");
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker Init Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Initialisation impossible : ${errorMsg}` });
        }
    }

    // --- EXÉCUTION DE L'OCR ---
    if (type === 'run' && imageBlob) {
        if (!model || !processor) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé.' });
            return;
        }

        try {
            // Debug: renvoi de l'image découpée au frontend
            const debugURL = URL.createObjectURL(imageBlob);
            self.postMessage({ status: 'debug_image', url: debugURL });

            const image = await RawImage.fromBlob(imageBlob);
            const task = '<OCR_WITH_REGION>';
            const inputs = await processor(image, task);

            // Génération avec Greedy Search pour la stabilité
            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: 256,
                num_beams: 1,
                do_sample: false,
            });

            const generatedText = processor.tokenizer.batch_decode(generatedIds, {
                skip_special_tokens: false,
            })[0];

            // --- NETTOYAGE BRUT ---
            // Suppression uniquement des balises <...> et des espaces multiples
            let cleanText = generatedText.replace(/<[^>]+>/g, ' ');
            cleanText = cleanText.replace(/\s+/g, ' ').trim();

            self.postMessage({ status: 'complete', text: cleanText });

        } catch (err) {
            console.error("[Worker Run Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Erreur OCR : ${errorMsg}` });
        }
    }
});