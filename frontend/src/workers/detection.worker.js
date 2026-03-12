import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

let detectionSession = null;
let orderSession = null;

const MODEL_PATH = 'https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector/resolve/main/onepiece_detector.onnx';
const ORDER_MODEL_PATH = 'https://huggingface.co/Remidesbois/bubble_reorder_ml/resolve/main/reading_order_v2.onnx';
const INPUT_DIM = 800;
const ORDER_DIM = 256;

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            if (detectionSession && orderSession) {
                self.postMessage({ status: 'ready' });
                return;
            }

            console.log("[Worker] Loading models...");

            const resp1 = await fetch(MODEL_PATH);
            const buf1 = new Uint8Array(await resp1.arrayBuffer());
            detectionSession = await ort.InferenceSession.create(buf1, {
                executionProviders: ['webgpu', 'wasm'],
                graphOptimizationLevel: 'all'
            });

            try {
                const resp2 = await fetch(ORDER_MODEL_PATH);
                if (resp2.ok) {
                    const buf2 = new Uint8Array(await resp2.arrayBuffer());
                    orderSession = await ort.InferenceSession.create(buf2, {
                        executionProviders: ['webgpu', 'wasm'],
                        graphOptimizationLevel: 'all'
                    });
                    console.log("[Worker] Reading order model loaded");
                } else {
                    console.warn("[Worker] Reading order model not found at", ORDER_MODEL_PATH);
                }
            } catch (e) {
                console.warn("[Worker] Failed to load reading order model:", e.message);
            }

            console.log("[Worker] Detection model loaded");
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker] Init Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!detectionSession) return;
        try {
            const bitmap = await createImageBitmap(imageBlob);

            const { inputTensor, scale, padX, padY } = await preprocess(bitmap, INPUT_DIM);
            const feeds = { [detectionSession.inputNames[0]]: inputTensor };
            const results = await detectionSession.run(feeds);
            const output = results[detectionSession.outputNames[0]].data;
            const boxes = simplifyPostProcess(output, scale, padX, padY);

            let sortedBoxes;
            if (orderSession && boxes.length > 1) {
                sortedBoxes = await mlReadingOrder(boxes, bitmap);
            } else {
                sortedBoxes = mangaOrderSort(boxes);
            }

            self.postMessage({ status: 'complete', boxes: sortedBoxes });
        } catch (err) {
            console.error("[Worker] Run Error:", err);
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

async function mlReadingOrder(boxes, bitmap) {
    const n = boxes.length;
    const pageRGB = preparePageRGB(bitmap);
    const scores = Array.from({ length: n }, () => new Float32Array(n));

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const prob = await comparePair(pageRGB, boxes[i], boxes[j], bitmap.width, bitmap.height);
            scores[i][j] = prob;
            scores[j][i] = 1 - prob;
        }
    }

    const indices = boxes.map((_, i) => i);
    const totalScore = indices.map(i =>
        indices.reduce((sum, j) => sum + (i !== j ? scores[i][j] : 0), 0)
    );
    indices.sort((a, b) => totalScore[b] - totalScore[a]);

    return indices.map(i => boxes[i]);
}

function preparePageRGB(bitmap) {
    const canvas = new OffscreenCanvas(ORDER_DIM, ORDER_DIM);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, ORDER_DIM, ORDER_DIM);
    const imageData = ctx.getImageData(0, 0, ORDER_DIM, ORDER_DIM);
    const { data } = imageData;

    const rgb = new Float32Array(3 * ORDER_DIM * ORDER_DIM);
    for (let i = 0; i < ORDER_DIM * ORDER_DIM; i++) {
        rgb[i]                              = data[i * 4]     / 255.0;
        rgb[ORDER_DIM * ORDER_DIM + i]      = data[i * 4 + 1] / 255.0;
        rgb[2 * ORDER_DIM * ORDER_DIM + i]  = data[i * 4 + 2] / 255.0;
    }
    return rgb;
}

const COORD_MAPS = (() => {
    const maps = new Float32Array(2 * ORDER_DIM * ORDER_DIM);
    for (let y = 0; y < ORDER_DIM; y++) {
        const yVal = (y / (ORDER_DIM - 1)) * 2 - 1;
        for (let x = 0; x < ORDER_DIM; x++) {
            const xVal = (x / (ORDER_DIM - 1)) * 2 - 1;
            maps[y * ORDER_DIM + x] = xVal;
            maps[ORDER_DIM * ORDER_DIM + y * ORDER_DIM + x] = yVal;
        }
    }
    return maps;
})();

async function comparePair(pageRGB, boxA, boxB, pageW, pageH) {
    const S = ORDER_DIM;
    const pixels = S * S;

    const maskA = new Float32Array(pixels);
    const maskB = new Float32Array(pixels);

    fillMask(maskA, boxA, pageW, pageH, S);
    fillMask(maskB, boxB, pageW, pageH, S);

    const inputData = new Float32Array(7 * pixels);
    inputData.set(pageRGB, 0);
    inputData.set(maskA, 3 * pixels);
    inputData.set(maskB, 4 * pixels);
    inputData.set(COORD_MAPS, 5 * pixels);

    const tensor = new ort.Tensor('float32', inputData, [1, 7, S, S]);
    const result = await orderSession.run({
        [orderSession.inputNames[0]]: tensor
    });

    return result[orderSession.outputNames[0]].data[0];
}

function fillMask(mask, box, pageW, pageH, size) {
    const x1 = Math.max(0, Math.floor(box.x / pageW * size));
    const y1 = Math.max(0, Math.floor(box.y / pageH * size));
    const x2 = Math.min(size, Math.ceil((box.x + box.w) / pageW * size));
    const y2 = Math.min(size, Math.ceil((box.y + box.h) / pageH * size));

    for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
            mask[y * size + x] = 1.0;
        }
    }
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