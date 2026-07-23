import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;
ort.env.wasm.simd = true;
ort.env.wasm.proxy = false;

const MODEL_PATH = new URL('/api/models/page-type', self.location.origin).href;
const LABELS = ['cover', 'story_page', 'annexe', 'summary'];
const IMAGE_SIZE = 224;
const RESIZE_SIZE = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let session = null;
let runtime = null;

async function createSession(executionProviders) {
    const response = await fetch(MODEL_PATH);
    if (!response.ok) {
        throw new Error(`Impossible de charger le modele de type de page (HTTP ${response.status}).`);
    }
    const model = await response.arrayBuffer();
    return ort.InferenceSession.create(model, {
        executionProviders,
        graphOptimizationLevel: 'all',
    });
}

async function ensureSession() {
    if (session) return { session, runtime };

    try {
        session = await createSession(['webgpu']);
        runtime = 'webgpu';
    } catch (webgpuError) {
        console.warn('[PageTypeWorker] WebGPU indisponible, bascule WASM.', webgpuError);
        session = await createSession(['wasm']);
        runtime = 'wasm';
    }
    return { session, runtime };
}

function softmax(logits) {
    const max = Math.max(...logits);
    const exponentials = logits.map((value) => Math.exp(value - max));
    const sum = exponentials.reduce((total, value) => total + value, 0);
    return exponentials.map((value) => value / sum);
}

async function imageToTensor(blob) {
    const image = await createImageBitmap(blob);
    try {
        const scale = RESIZE_SIZE / Math.min(image.width, image.height);
        const resizedWidth = Math.round(image.width * scale);
        const resizedHeight = Math.round(image.height * scale);
        const resized = new OffscreenCanvas(resizedWidth, resizedHeight);
        resized.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, resizedWidth, resizedHeight);

        const crop = new OffscreenCanvas(IMAGE_SIZE, IMAGE_SIZE);
        const left = Math.floor((resizedWidth - IMAGE_SIZE) / 2);
        const top = Math.floor((resizedHeight - IMAGE_SIZE) / 2);
        const cropContext = crop.getContext('2d', { willReadFrequently: true });
        cropContext.drawImage(resized, left, top, IMAGE_SIZE, IMAGE_SIZE, 0, 0, IMAGE_SIZE, IMAGE_SIZE);

        const pixels = cropContext.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
        const data = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
        const planeSize = IMAGE_SIZE * IMAGE_SIZE;
        for (let pixelIndex = 0; pixelIndex < planeSize; pixelIndex += 1) {
            const sourceOffset = pixelIndex * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                data[channel * planeSize + pixelIndex] = (pixels[sourceOffset + channel] / 255 - MEAN[channel]) / STD[channel];
            }
        }
        return new ort.Tensor('float32', data, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
    } finally {
        image.close();
    }
}

async function classify(blob) {
    const activeSession = await ensureSession();
    const input = await imageToTensor(blob);
    const output = await activeSession.session.run({
        [activeSession.session.inputNames[0]]: input,
    });
    const logits = Array.from(output[activeSession.session.outputNames[0]].data);
    const values = softmax(logits);
    const bestIndex = values.indexOf(Math.max(...values));
    return {
        label: LABELS[bestIndex],
        confidence: values[bestIndex],
        probabilities: Object.fromEntries(LABELS.map((label, index) => [label, values[index]])),
    };
}

self.addEventListener('message', async (event) => {
    const { type, jobId, pages = [] } = event.data;
    if (type !== 'classify') return;

    try {
        const activeSession = await ensureSession();
        for (let index = 0; index < pages.length; index += 1) {
            const page = pages[index];
            const prediction = await classify(page.blob);
            self.postMessage({
                type: 'progress',
                jobId,
                completed: index + 1,
                total: pages.length,
                pageId: page.id,
                prediction,
                runtime: activeSession.runtime,
            });
        }
        self.postMessage({ type: 'completed', jobId, runtime: activeSession.runtime });
    } catch (error) {
        self.postMessage({
            type: 'error',
            jobId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});
