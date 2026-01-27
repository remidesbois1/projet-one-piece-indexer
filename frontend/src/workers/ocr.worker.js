import { AutoProcessor, Florence2ForConditionalGeneration, RawImage, Tensor, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = false;

let model = null;
let processor = null;

const MODEL_ID = 'Remidesbois/florence2-onepiece-ocr';

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

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

    if (type === 'run' && imageBlob) {
        if (!model || !processor) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé.' });
            return;
        }

        try {
            const debugURL = URL.createObjectURL(imageBlob);
            self.postMessage({ status: 'debug_image', url: debugURL });

            const image = await RawImage.fromBlob(imageBlob);
            const task = '<OCR>';
            const inputs = await processor(image, task);

            // MANUALLY OVERRIDING INPUT IDS to match the successful Python test
            // Python IDs: [0, 2264, 16, 5, 2788, 11, 5, 2274, 116, 2]
            const manualIds = new BigInt64Array([0n, 2264n, 16n, 5n, 2788n, 11n, 5n, 2274n, 116n]);

            // Re-create the tensors with fixed size
            inputs.input_ids = new Tensor('int64', manualIds, [1, 9]);
            inputs.attention_mask = new Tensor('int64', new BigInt64Array(9).fill(1n), [1, 9]);

            console.log("[Worker] Prompt IDs (Python Match):", inputs.input_ids.data);

            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: 256,
                num_beams: 3,
                do_sample: false,
            });

            // Decode everything to see the raw output from the model
            const generatedText = processor.tokenizer.batch_decode(generatedIds, {
                skip_special_tokens: false,
            })[0];

            console.log("[Worker] Raw generated text:", generatedText);

            // Robust cleaning:
            // 1. Remove known special tokens like <s>, </s>, <pad>
            let cleanText = generatedText.replace(/<s>|<\/s>|<pad>|<mask>/g, '');

            // 2. Remove the task tag (case insensitive just in case)
            const taskRegex = new RegExp(task, 'gi');
            cleanText = cleanText.replace(taskRegex, '');

            // 3. Remove any remaining location or structural tags (like <loc_123> or </ocr>)
            cleanText = cleanText.replace(/<[^>]+>/g, ' ');

            // 4. Final trim and cleanup
            cleanText = cleanText.replace(/\s+/g, ' ').trim();

            self.postMessage({ status: 'complete', text: cleanText });

        } catch (err) {
            console.error("[Worker Run Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Erreur OCR : ${errorMsg}` });
        }
    }
});