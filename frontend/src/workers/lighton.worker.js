import { AutoProcessor, AutoTokenizer, AutoModelForImageTextToText, RawImage, env } from '@huggingface/transformers';
import { fixFrenchPunctuation } from '../lib/ocr-utils.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

if (!env.backends.webgpu) env.backends.webgpu = {};
env.backends.webgpu.powerPreference = "high-performance";

// Variables globales du worker
let model = null;
let processor = null;
let tokenizer = null;

const MODEL_ID = 'Remidesbois/LightonOCR-2-1b-poneglyph-ONNX';
const EOS_TOKEN_ID = 151645;
const BAD_TOKEN_ID = 151935n;


function createNanSafetyProcessor() {
    let nanDetected = false;

    const proc = (input_ids, logits) => {
        const data = logits.data; // Flat Float32Array [batch * vocab_size]

        // Quick scan — sample every 64th value. If overflow occurred in the model,
        for (let i = 0; i < data.length; i += 64) {
            if (!Number.isFinite(data[i])) {
                nanDetected = true;
                console.warn('[Worker] FP16 overflow: NaN/Inf detected in logits — forcing EOS');

                for (let j = 0; j < data.length; j++) {
                    data[j] = (j === EOS_TOKEN_ID) ? 0 : -Infinity;
                }
                return logits;
            }
        }
        return logits;
    };

    proc.wasNanDetected = () => nanDetected;
    return proc;
}


async function ocrSingleImage(imageBlob) {
    const MAX_ATTEMPTS = 3;
    const SCALE_FACTORS = [1.0, 0.65, 0.4];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let image = await RawImage.fromBlob(imageBlob);

        // On retry, downscale the image to reduce vision token count
        // and lower the chance of FP16 overflow in attention layers.
        if (attempt > 0) {
            const scale = SCALE_FACTORS[attempt];
            const newW = Math.max(28, Math.round(image.width * scale));
            const newH = Math.max(28, Math.round(image.height * scale));
            image = await image.resize(newW, newH);
            console.log(`[Worker] FP16 overflow retry ${attempt}/${MAX_ATTEMPTS - 1}: image scaled to ${newW}x${newH}`);
        }


        const text_prompt = "<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|image_pad|>\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :<|im_end|>\n<|im_start|>assistant\n";

        const inputs = await processor(image, text_prompt, {
            add_special_tokens: false
        });

        console.log('[Worker] input_ids shape:', inputs.input_ids.dims);
        console.log('[Worker] input_ids sample:', inputs.input_ids.tolist()[0].slice(0, 10));

        const nanProcessor = createNanSafetyProcessor();

        const outputs = await model.generate({
            ...inputs,
            max_new_tokens: 128,
            do_sample: false,
            eos_token_id: EOS_TOKEN_ID,
            logits_processor: [nanProcessor],
        });

        const inputLength = inputs.input_ids.dims[1];
        const generatedTokens = outputs.tolist()[0].slice(inputLength);

        console.log('[Worker] Tokens bruts:', generatedTokens.slice(0, 20));

        if (nanProcessor.wasNanDetected()) {
            console.warn(`[Worker] FP16 overflow confirmed via NaN at attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
            if (attempt < MAX_ATTEMPTS - 1) continue;
            console.error('[Worker] All attempts failed due to FP16 overflow');
            return '';
        }


        const badCount = generatedTokens.filter(t => t === BAD_TOKEN_ID).length;
        if (generatedTokens.length > 2 && badCount > generatedTokens.length * 0.5) {
            console.warn(`[Worker] FP16 overflow detected via bad tokens: ${badCount}/${generatedTokens.length} at attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
            if (attempt < MAX_ATTEMPTS - 1) continue;
            console.error('[Worker] All attempts failed due to FP16 overflow');
            return '';
        }

        console.log('[Worker] Tokens décodés (avec spéciaux):', tokenizer.decode(generatedTokens, { skip_special_tokens: false }).trim());

        const decoded = tokenizer.decode(generatedTokens, {
            skip_special_tokens: true
        }).trim();

        return decoded;
    }

    return ''; // Should never reach here
}

// --- GESTIONNAIRE D'ÉVÉNEMENTS DU WORKER ---
self.addEventListener('message', async (event) => {
    const { type, imageBlob, requestId } = event.data;

    // --- PHASE D'INITIALISATION ---
    if (type === 'init') {
        try {
            if (model && processor && tokenizer) {
                self.postMessage({ status: 'ready', modelKey: 'lighton_local' });
                return;
            }

            console.log(`[Worker] Démarrage du chargement de ${MODEL_ID} (FP16/WebGPU)...`);

            // Suivi de progression du téléchargement
            let downloadProgressMap = {};
            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    downloadProgressMap[data.file] = data;
                    let totalLoaded = 0;
                    let totalExpected = 0;

                    for (const key in downloadProgressMap) {
                        const fileData = downloadProgressMap[key];
                        if (fileData.total) {
                            totalLoaded += fileData.loaded || 0;
                            totalExpected += fileData.total;
                        }
                    }

                    // Estimation de base pour l'UX si le total n'est pas encore connu
                    const realisticTotal = Math.max(totalExpected, 500_000_000);
                    const overallProgress = (totalLoaded / realisticTotal) * 100;

                    self.postMessage({
                        status: 'download_progress',
                        file: data.file,
                        progress: Math.min(overallProgress, 100)
                    });
                }
            };

            processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: progressCallback });
            tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: progressCallback });

            // Chargement du modèle avec la contrainte FP16 globale
            model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
                device: 'webgpu',
                dtype: "fp16",
                progress_callback: progressCallback
            });

            console.log(`[Worker] Modèle ${MODEL_ID} chargé avec succès en FP16 natif.`);
            self.postMessage({ status: 'ready', modelKey: 'lighton_local' });

        } catch (err) {
            console.error("[Worker Init Error]", err);
            self.postMessage({ status: 'error', error: `Initialisation impossible : ${err.message}` });
        }
    }

    // --- PHASE D'INFÉRENCE ---
    if (type === 'run' && imageBlob) {
        if (!model || !processor || !tokenizer) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé.', requestId });
            return;
        }

        try {
            const raw = await ocrSingleImage(imageBlob);
            const text = fixFrenchPunctuation(raw);

            console.log("[Worker] Résultat Poneglyph OCR :", text);
            self.postMessage({ status: 'complete', text, requestId });

        } catch (err) {
            console.error("[Worker Run Error]", err);
            self.postMessage({ status: 'error', error: `Erreur OCR : ${err.message}`, requestId });
        }
    }
});
