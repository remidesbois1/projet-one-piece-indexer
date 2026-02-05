import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

let session = null;
const MODEL_PATH = 'https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector/resolve/main/onepiece_detector.onnx';
const INPUT_DIM = 800;

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            if (session) {
                self.postMessage({ status: 'ready' });
                return;
            }

            console.log("[DetectionWorker] Loading model & initializing WebGPU...");

            const response = await fetch(MODEL_PATH);
            const arrayBuffer = await response.arrayBuffer();
            const modelBuffer = new Uint8Array(arrayBuffer);

            session = await ort.InferenceSession.create(modelBuffer, {
                executionProviders: ['webgpu', 'wasm'],
                graphOptimizationLevel: 'all'
            });

            console.log(`[DetectionWorker] Model loaded on: ${session.handler.provider}`);
            self.postMessage({ status: 'ready' });

        } catch (err) {
            console.error("[DetectionWorker] Init Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!session) return;

        try {
            const bitmap = await createImageBitmap(imageBlob);
            const { inputTensor, scale, padX, padY } = await preprocess(bitmap, INPUT_DIM);

            const feeds = { [session.inputNames[0]]: inputTensor };
            const results = await session.run(feeds);

            const output = results[session.outputNames[0]].data;

            const boxes = simplifyPostProcess(output, scale, padX, padY);

            const sortedBoxes = mangaOrderSort(boxes);

            self.postMessage({ status: 'complete', boxes: sortedBoxes });

        } catch (err) {
            console.error("[DetectionWorker] Run Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }
});

async function preprocess(bitmap, targetSize) {
    const { width, height } = bitmap;
    const scale = Math.min(targetSize / width, targetSize / height);
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    const padX = (targetSize - newW) / 2;
    const padY = (targetSize - newH) / 2;

    const canvas = new OffscreenCanvas(targetSize, targetSize);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, targetSize, targetSize);
    ctx.drawImage(bitmap, padX, padY, newW, newH);

    const imageData = ctx.getImageData(0, 0, targetSize, targetSize);
    const { data } = imageData;
    const float32Data = new Float32Array(3 * targetSize * targetSize);

    for (let i = 0; i < targetSize * targetSize; i++) {
        float32Data[i] = data[i * 4] / 255.0;
        float32Data[targetSize * targetSize + i] = data[i * 4 + 1] / 255.0;
        float32Data[2 * targetSize * targetSize + i] = data[i * 4 + 2] / 255.0;
    }

    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, targetSize, targetSize]);
    return { inputTensor, scale, padX, padY };
}

function simplifyPostProcess(data, scale, padX, padY) {
    const boxes = [];
    for (let i = 0; i < data.length; i += 6) {
        const score = data[i + 4];
        if (score < 0.25) continue;

        let x1 = (data[i] - padX) / scale;
        let y1 = (data[i + 1] - padY) / scale;
        let x2 = (data[i + 2] - padX) / scale;
        let y2 = (data[i + 3] - padY) / scale;

        boxes.push({
            x: Math.round(x1),
            y: Math.round(y1),
            w: Math.round(x2 - x1),
            h: Math.round(y2 - y1),
            score: score
        });
    }
    return boxes;
}

function mangaOrderSort(boxes) {
    if (boxes.length === 0) return [];

    const ROW_TOLERANCE = 100;

    boxes.sort((a, b) => a.y - b.y);

    const rows = [];
    for (const box of boxes) {
        let added = false;
        if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            if (Math.abs(box.y - lastRow[0].y) < ROW_TOLERANCE) {
                lastRow.push(box);
                added = true;
            }
        }
        if (!added) rows.push([box]);
    }

    const sortedBoxes = [];
    for (const row of rows) {
        row.sort((a, b) => b.x - a.x);
        sortedBoxes.push(...row);
    }

    return sortedBoxes;
}