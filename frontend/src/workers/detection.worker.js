import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

let detectionSession = null;
let orderSession = null;

const MODEL_PATH = 'https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector_Nano/resolve/main/onepiece_detector_nano.onnx';
const ORDER_MODEL_PATH = 'https://huggingface.co/Remidesbois/ReaderNet-V5/resolve/main/readernet_v5.onnx';
const INPUT_DIM = 1024;
const ORDER_H = 256;
const ORDER_W = 384;

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            if (detectionSession && orderSession) {
                self.postMessage({ status: 'ready' });
                return;
            }

            console.log("[Worker] Loading models...");

            const fetchWithProgress = async (url, baseProgress, maxProgress) => {
                const response = await fetch(url);
                const contentLength = response.headers.get('content-length');
                const total = contentLength ? parseInt(contentLength, 10) : 0;
                let loaded = 0;
                const chunks = [];
                const reader = response.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.byteLength;
                    if (total) {
                        const progress = baseProgress + (loaded / total) * (maxProgress - baseProgress);
                        self.postMessage({ status: 'download_progress', progress });
                    } else {
                        const progress = baseProgress + (maxProgress - baseProgress) * Math.min(0.9, loaded / 10000000);
                        self.postMessage({ status: 'download_progress', progress });
                    }
                }
                self.postMessage({ status: 'download_progress', progress: maxProgress });

                const arrayBuffer = new Uint8Array(loaded);
                let offset = 0;
                for (const chunk of chunks) {
                    arrayBuffer.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return arrayBuffer;
            };

            const buf1 = await fetchWithProgress(MODEL_PATH, 0, 50);
            detectionSession = await ort.InferenceSession.create(buf1, {
                executionProviders: ['webgpu', 'wasm'],
                graphOptimizationLevel: 'all'
            });

            try {
                const buf2 = await fetchWithProgress(ORDER_MODEL_PATH, 50, 100);
                orderSession = await ort.InferenceSession.create(buf2, {
                    executionProviders: ['webgpu', 'wasm'],
                    graphOptimizationLevel: 'all'
                });
                console.log("[Worker] ReaderNet V5 loaded");
            } catch (e) {
                console.warn("[Worker] Failed to load ReaderNet V5:", e.message);
            }

            console.log("[Worker] Detection models loaded");
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
    const { imageTensor, ratio, padLeft } = preparePageGrayscale(bitmap);

    const norm = boxes.map(b => {
        const x = (b.x * ratio + padLeft) / ORDER_W;
        const y = (b.y * ratio) / ORDER_H;
        const w = (b.w * ratio) / ORDER_W;
        const h = (b.h * ratio) / ORDER_H;
        const cx = x + w / 2;
        const cy = y + h / 2;
        return { x, y, w, h, cx, cy };
    });

    const scores = Array.from({ length: n }, () => new Float32Array(n));

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const a = norm[i];
            const b = norm[j];
            const dx = b.cx - a.cx;
            const dy = b.cy - a.cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx) / Math.PI;

            const geometryVec = new Float32Array([
                a.x, a.y, a.w, a.h,
                b.x, b.y, b.w, b.h,
                dx, dy, dist, angle
            ]);

            const geomTensor = new ort.Tensor('float32', geometryVec, [1, 12]);
            const results = await orderSession.run({
                image: imageTensor,
                geometry: geomTensor
            });

            const logit = results.prediction.data[0];
            const prob = 1 / (1 + Math.exp(-logit));

            scores[i][j] = prob;
        }
    }

    const indices = boxes.map((_, i) => i);
    const totalScore = indices.map(i =>
        indices.reduce((sum, j) => sum + (i !== j ? scores[i][j] : 0), 0)
    );
    indices.sort((a, b) => totalScore[b] - totalScore[a]);

    return indices.map(i => boxes[i]);
}

function preparePageGrayscale(bitmap) {
    const { width, height } = bitmap;
    const ratio = ORDER_H / height;
    const newW = Math.round(width * ratio);
    const clampedW = Math.min(newW, ORDER_W);
    const padLeft = Math.floor((ORDER_W - clampedW) / 2);

    const canvas = new OffscreenCanvas(ORDER_W, ORDER_H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, ORDER_W, ORDER_H);

    ctx.drawImage(bitmap, padLeft, 0, clampedW, ORDER_H);

    const imageData = ctx.getImageData(0, 0, ORDER_W, ORDER_H);
    const { data } = imageData;
    const grayscale = new Float32Array(ORDER_W * ORDER_H);

    for (let i = 0; i < ORDER_W * ORDER_H; i++) {
        grayscale[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255.0;
    }

    const imageTensor = new ort.Tensor('float32', grayscale, [1, 1, ORDER_H, ORDER_W]);
    return { imageTensor, ratio, padLeft };
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