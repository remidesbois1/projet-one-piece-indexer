import { AutoProcessor, AutoTokenizer, AutoModelForImageTextToText, RawImage, env } from '@huggingface/transformers';
import { fixFrenchPunctuation } from '../lib/ocr-utils.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
// FORCER L'UTILISATION DE LA CARTE GRAPHIQUE DEDIEE (RTX 3090) ET NON LE GPU INTEGRE
if (!env.backends.webgpu) env.backends.webgpu = {};
env.backends.webgpu.powerPreference = "high-performance";

// --- MONKEY PATCH POUR TRANSFORMERS.JS BUG ---
// L'algorithme de redimensionnement de Pixtral calcule souvent des flottants (ex: 300.5) ou des NaN!
if (RawImage.prototype.resize && !RawImage.prototype._patched) {
    const originalResize = RawImage.prototype.resize;
    RawImage.prototype.resize = function(arg1, arg2, arg3) {
        let w = arg1, h = arg2;
        let isInvalid = false;
        
        if (typeof arg1 === 'number') {
            w = Math.round(arg1);
            if (Number.isNaN(w) || w <= 0) isInvalid = true;
        }
        if (typeof arg2 === 'number') {
            h = Math.round(arg2);
            if (Number.isNaN(h) || h <= 0) isInvalid = true;
        }
        
        if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
            w = { ...arg1 };
            if (w.width !== undefined) {
                w.width = Math.round(w.width);
                if (Number.isNaN(w.width) || w.width <= 0) isInvalid = true;
            }
            if (w.height !== undefined) {
                w.height = Math.round(w.height);
                if (Number.isNaN(w.height) || w.height <= 0) isInvalid = true;
            }
        } else if (Array.isArray(arg1)) {
            w = [Math.round(arg1[0]), Math.round(arg1[1])];
            if (Number.isNaN(w[0]) || Number.isNaN(w[1]) || w[0] <= 0 || w[1] <= 0) isInvalid = true;
        }
        
        if (isInvalid) {
            console.warn("[Monkey Patch] Transformers.js resize calculǸ invalid size. Bypass du resize.", arg1, arg2);
            return this.clone();
        }
        
        return originalResize.call(this, w, h, arg3);
    };
    RawImage.prototype._patched = true;
}
// ---------------------------------------------

let model = null;
let processor = null;
let tokenizer = null;

const MODEL_ID = 'Remidesbois/LightonOCR-2-1b-poneglyph-ONNX';

async function ocrSingleImage(imageBlob) {
    const imgBitmap = await createImageBitmap(imageBlob);
    
    // Pixtral/Qwen requiert que l'image soit un multiple exact du patch_size (14).
    const patchSize = 14;
    const newW = Math.ceil(imgBitmap.width / patchSize) * patchSize;
    const newH = Math.ceil(imgBitmap.height / patchSize) * patchSize;
    
    const canvas = new OffscreenCanvas(newW, newH);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, newW, newH);
    ctx.drawImage(imgBitmap, 0, 0);
    
    const paddedBlob = await canvas.convertToBlob();
    const image = await RawImage.fromBlob(paddedBlob);

    const messages = [
        {
            role: "user",
            content: [
                { type: "image" },
                { type: "text", text: "Extrais le texte de cette image.\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :" }
            ]
        }
    ];

    const text_prompt = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false
    });

    // Envoi de l'image et du prompt au processeur
    const inputs = await processor(image, text_prompt, { 
        add_special_tokens: false,
        do_resize: false
    });

    const outputs = await model.generate({
        ...inputs,
        max_new_tokens: 128,
        do_sample: false
    });

    const inputLength = inputs.input_ids.dims[1];

    // Extraction des tokens gǸnǸrǸs
    const outputList = outputs.tolist();
    const generatedTokens = outputList[0].slice(inputLength);

    const decoded = tokenizer.decode(generatedTokens, {
        skip_special_tokens: true
    }).trim();

    return decoded;
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob, requestId } = event.data;

    if (type === 'init') {
        try {
            if (model && processor && tokenizer) {
                self.postMessage({ status: 'ready', modelKey: 'lighton_local' });
                return;
            }

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            console.log(`[Worker] Chargement de ${MODEL_ID} (WebGPU)...`);

            processor = await AutoProcessor.from_pretrained(MODEL_ID, {
                progress_callback: progressCallback
            });

            tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
                progress_callback: progressCallback
            });

            model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
                device: 'webgpu',
                dtype: { 
                    embed_tokens: "fp16",
                    decoder_model_merged: "q8",
                    vision_encoder: "fp32"
                },
                progress_callback: progressCallback
            });

            console.log(`[Worker] Modle ${MODEL_ID} chargǸ et prǦt.`);
            self.postMessage({ status: 'ready', modelKey: 'lighton_local' });

        } catch (err) {
            console.error("[Worker Init Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Initialisation impossible : ${errorMsg}` });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!model || !processor || !tokenizer) {
            self.postMessage({ status: 'error', error: 'Modle non chargǸ.', requestId });
            return;
        }

        try {
            const raw = await ocrSingleImage(imageBlob);
            const text = fixFrenchPunctuation(raw);

            console.log("[Worker] Lighton OCR result:", text);
            self.postMessage({ status: 'complete', text, requestId });

        } catch (err) {
            console.error("[Worker Run Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Erreur OCR : ${errorMsg}`, requestId });
        }
    }
});