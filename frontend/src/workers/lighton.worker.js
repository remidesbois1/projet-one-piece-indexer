import { MLCEngine, CreateMLCEngine } from "@mlc-ai/web-llm";

// Configuration for LightOnOCR-2-1B
// Note: This requires the model to be hosted/accessible or already in cache
const DEFAULT_MODEL_ID = "LightOnOCR-2-1B-q4f16_1-MLC"; // Example MLC ID

let engine = null;
let currentModel = null;

async function initEngine(modelId, progressCallback) {
    if (engine && currentModel === modelId) return;
    
    engine = await CreateMLCEngine(modelId, {
        initProgressCallback: progressCallback,
    });
    currentModel = modelId;
}

self.onmessage = async (e) => {
    const { type, modelId, image, requestId } = e.data;

    if (type === "init") {
        try {
            await initEngine(modelId || DEFAULT_MODEL_ID, (p) => {
                self.postMessage({ status: 'progress', progress: p, requestId });
            });
            self.postMessage({ status: 'ready', requestId });
        } catch (err) {
            self.postMessage({ status: 'error', error: err.message, requestId });
        }
    }

    if (type === "run") {
        if (!engine) {
            self.postMessage({ status: 'error', error: "Engine not initialized", requestId });
            return;
        }

        try {
            // LightOnOCR usually takes 1 image and extracts text
            // We follow the MLC-AI VLM format
            const messages = [
                {
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: image } },
                        { type: "text", text: "Extrais le texte de cette image." }
                    ]
                }
            ];

            const reply = await engine.chat.completions.create({
                messages,
                max_tokens: 1024,
                temperature: 0,
            });

            const text = reply.choices[0].message.content;
            self.postMessage({ status: 'complete', text, requestId });
        } catch (err) {
            self.postMessage({ status: 'error', error: err.message, requestId });
        }
    }
};
