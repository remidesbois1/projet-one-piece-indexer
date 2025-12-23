import { AutoProcessor, Florence2ForConditionalGeneration, RawImage, env } from '@huggingface/transformers';

// Configuration
env.allowLocalModels = false;
env.useBrowserCache = true;

let model = null;
let processor = null;

const MODEL_ID = 'onnx-community/Florence-2-base-ft';

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            console.log(`[Worker] Démarrage du téléchargement ${MODEL_ID}...`);
            
            // Fonction de rappel pour la progression du téléchargement
            const progressCallback = (data) => {
                // data contient : { status, file, name, progress, loaded, total }
                if (data.status === 'progress') {
                    self.postMessage({ 
                        status: 'download_progress', 
                        file: data.file, 
                        progress: data.progress 
                    });
                }
            };

            // 1. Chargement du Modèle (FP32 + WebGPU) avec progression
            model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
                dtype: 'fp32',
                device: 'webgpu',
                progress_callback: progressCallback
            });
            
            // 2. Chargement du Processeur avec progression
            processor = await AutoProcessor.from_pretrained(MODEL_ID, {
                progress_callback: progressCallback
            });
            
            console.log("[Worker] Florence-2 (FP32) prêt !");
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker] Erreur init:", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Echec init (${errorMsg})` });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!model || !processor) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé. Veuillez le télécharger.' });
            return;
        }

        try {
            const debugURL = URL.createObjectURL(imageBlob);
            self.postMessage({ status: 'debug_image', url: debugURL });

            const image = await RawImage.fromBlob(imageBlob);
            const text = '<OCR>';
            const inputs = await processor(image, text);

            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: 128,
                
                num_beams: 3,
                early_stopping: true,
                do_sample: false,
                repetition_penalty: 1.05,
            });

            const generatedText = processor.tokenizer.batch_decode(generatedIds, {
                skip_special_tokens: false,
            })[0];
            
            let cleanText = generatedText.replace(/<\/?s>|<OCR>/g, '').trim();

            self.postMessage({ status: 'complete', text: cleanText });

        } catch (err) {
            console.error("[Worker] Erreur run:", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: errorMsg });
        }
    }
});