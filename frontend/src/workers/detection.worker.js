import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

// ---------------------------------------------------------------------------
// Model URLs
// ---------------------------------------------------------------------------
const BUBBLE_MODEL_PATH = 'https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector_Nano/resolve/main/onepiece_detector_nano.onnx';
const PANEL_MODEL_PATH = 'https://huggingface.co/Remidesbois/YoloPiece_PanelDetector/resolve/main/panel_detector.onnx';
const PANEL_ORDER_PATH = 'https://huggingface.co/Remidesbois/YoloPiece_PanelDetector/resolve/main/reading_order.onnx';
const READERNET_PATH = 'https://huggingface.co/Remidesbois/ReaderNet-Poneglyph/resolve/main/readernet_poneglyph.onnx';

const BUBBLE_INPUT_DIM = 1024;
const PAGE_H = 256;
const PAGE_W = 384;
const BUBBLE_CROP_SIZE = 96;
const PANEL_CROP_SIZE = 224;

let bubbleSession = null;
let panelSession = null;
let panelOrderSession = null;
let readernetSession = null;

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------
async function fetchModel(url, onProgress) {
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
        if (total && onProgress) {
            onProgress(loaded, total);
        }
    }
    const arrayBuffer = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        arrayBuffer.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return arrayBuffer;
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            if (bubbleSession && panelSession && panelOrderSession && readernetSession) {
                self.postMessage({ status: 'ready' });
                return;
            }

            console.log("[Worker] Loading models...");

            const models = [
                { path: BUBBLE_MODEL_PATH, name: 'Bubble Detector' },
                { path: PANEL_MODEL_PATH, name: 'Panel Detector' },
                { path: PANEL_ORDER_PATH, name: 'Panel Order' },
                { path: READERNET_PATH, name: 'ReaderNet' }
            ];

            const sizes = await Promise.all(models.map(async (m) => {
                try {
                    const resp = await fetch(m.path, { method: 'HEAD' });
                    return parseInt(resp.headers.get('content-length') || '0', 10);
                } catch { return 0; }
            }));

            const totalSize = sizes.reduce((a, b) => a + b, 0);
            let totalLoaded = 0;

            const updateGlobalProgress = (loadedInFile, fileTotal) => {
                if (totalSize > 0) {
                    const loaded = totalLoaded + loadedInFile;
                    const currentProgress = (loaded / totalSize) * 100;
                    self.postMessage({
                        status: 'download_progress',
                        progress: currentProgress,
                        loadedBytes: loaded,
                        totalBytes: totalSize
                    });
                }
            };

            // 1. Bubble Detector
            const buf1 = await fetchModel(BUBBLE_MODEL_PATH, updateGlobalProgress);
            bubbleSession = await ort.InferenceSession.create(buf1, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            totalLoaded += buf1.byteLength;
            console.log("[Worker] Bubble detector loaded");

            // 2. Panel Detector
            const buf2 = await fetchModel(PANEL_MODEL_PATH, updateGlobalProgress);
            panelSession = await ort.InferenceSession.create(buf2, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            totalLoaded += buf2.byteLength;
            console.log("[Worker] Panel detector loaded");

            // 3. Panel Order
            try {
                const buf3 = await fetchModel(PANEL_ORDER_PATH, updateGlobalProgress);
                panelOrderSession = await ort.InferenceSession.create(buf3, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
                totalLoaded += buf3.byteLength;
                console.log("[Worker] Panel order model loaded");
            } catch (e) { console.warn("[Worker] Failed to load panel order:", e.message); }

            // 4. ReaderNet
            try {
                const buf4 = await fetchModel(READERNET_PATH, updateGlobalProgress);
                readernetSession = await ort.InferenceSession.create(buf4, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
                totalLoaded += buf4.byteLength;
                console.log("[Worker] ReaderNet loaded");
            } catch (e) { console.warn("[Worker] Failed to load ReaderNet:", e.message); }

            self.postMessage({ status: 'download_progress', progress: 100 });
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker] Init Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!bubbleSession) return;
        try {
            const bitmap = await createImageBitmap(imageBlob);
            const { width: imgW, height: imgH } = bitmap;

            // 1. Detect bubbles
            const { inputTensor, scale, padX, padY } = preprocessBubble(bitmap, BUBBLE_INPUT_DIM);
            const bubbleFeeds = { [bubbleSession.inputNames[0]]: inputTensor };
            const bubbleResults = await bubbleSession.run(bubbleFeeds);
            const bubbleOutput = bubbleResults[bubbleSession.outputNames[0]].data;
            const boxes = simplifyPostProcess(bubbleOutput, scale, padX, padY);

            if (boxes.length <= 1) {
                self.postMessage({ status: 'complete', boxes });
                return;
            }

            let sortedBoxes;

            // 2. Detect panels
            const panels = await detectPanels(bitmap);

            if (panels.length > 0 && panelOrderSession && readernetSession) {
                // 3. Sort panels by reading order
                const sortedPanels = await rankPanels(panels, bitmap);

                // 4. Assign bubbles to panels
                const assignments = assignBubblesToPanels(boxes, sortedPanels);

                // 5. Sort bubbles within each panel using ReaderNet
                sortedBoxes = await sortBubblesWithReaderNet(boxes, sortedPanels, assignments, bitmap);
            } else {
                // Fallback: old heuristic sort
                sortedBoxes = mangaOrderSort(boxes);
            }

            self.postMessage({ status: 'complete', boxes: sortedBoxes });
        } catch (err) {
            console.error("[Worker] Run Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }
});

// ---------------------------------------------------------------------------
// Bubble detector preprocessing
// ---------------------------------------------------------------------------
function preprocessBubble(bitmap, targetSize) {
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

// ---------------------------------------------------------------------------
// Panel detection (YOLO-pose)
// ---------------------------------------------------------------------------
async function detectPanels(bitmap) {
    if (!panelSession) return [];

    const { width, height } = bitmap;

    let inH = 800, inW = 800;
    try {
        const inName = panelSession.inputNames?.[0];
        const meta = panelSession.inputMetadata?.[inName];
        if (meta?.dims && meta.dims.length >= 4) {
            inH = meta.dims[2];
            inW = meta.dims[3];
        }
    } catch (e) {
        console.warn("[Worker] Could not read panel detector input dims, using 800x800");
    }

    const scale = Math.min(inW / width, inH / height);
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    const padLeft = Math.floor((inW - newW) / 2);
    const padTop = Math.floor((inH - newH) / 2);

    const canvas = new OffscreenCanvas(inW, inH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, inW, inH);
    ctx.drawImage(bitmap, padLeft, padTop, newW, newH);

    const imageData = ctx.getImageData(0, 0, inW, inH);
    const { data } = imageData;
    const float32Data = new Float32Array(3 * inW * inH);
    for (let i = 0; i < inW * inH; i++) {
        float32Data[i] = data[i * 4] / 255.0;
        float32Data[inW * inH + i] = data[i * 4 + 1] / 255.0;
        float32Data[2 * inW * inH + i] = data[i * 4 + 2] / 255.0;
    }

    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, inH, inW]);
    const feeds = { [panelSession.inputNames[0]]: inputTensor };
    const results = await panelSession.run(feeds);

    const outKeys = Object.keys(results);
    if (!outKeys.length) return [];
    
    const output = results[outKeys[0]];
    const d = output.dims;
    let numPreds, numFeatures, isTransposed;
    if (d.length === 3) {
        if (d[1] > d[2]) {
            numPreds = d[1];
            numFeatures = d[2];
            isTransposed = true;
        } else {
            numPreds = d[2];
            numFeatures = d[1];
            isTransposed = false;
        }
    } else {
        return [];
    }

    const raw = output.data;
    const candidates = [];
    for (let col = 0; col < numPreds; col++) {
        let conf, cx, cy, w, h;
        if (isTransposed) {
            conf = raw[col * numFeatures + 4];
            cx = raw[col * numFeatures + 0];
            cy = raw[col * numFeatures + 1];
            w  = raw[col * numFeatures + 2];
            h  = raw[col * numFeatures + 3];
        } else {
            conf = raw[4 * numPreds + col];
            cx = raw[0 * numPreds + col];
            cy = raw[1 * numPreds + col];
            w  = raw[2 * numPreds + col];
            h  = raw[3 * numPreds + col];
        }

        if (conf < 0.25) continue;

        const x1 = cx - w / 2;
        const y1 = cy - h / 2;
        const x2 = cx + w / 2;
        const y2 = cy + h / 2;

        candidates.push({ x1, y1, x2, y2, w, h, conf, idx: col });
    }

    candidates.sort((a, b) => b.conf - a.conf);
    const keep = [];
    const areas = candidates.map(c => (c.x2 - c.x1) * (c.y2 - c.y1));

    for (let i = 0; i < candidates.length; i++) {
        if (candidates[i].suppressed) continue;
        keep.push(candidates[i]);
        for (let j = i + 1; j < candidates.length; j++) {
            if (candidates[j].suppressed) continue;
            const xx1 = Math.max(candidates[i].x1, candidates[j].x1);
            const yy1 = Math.max(candidates[i].y1, candidates[j].y1);
            const xx2 = Math.min(candidates[i].x2, candidates[j].x2);
            const yy2 = Math.min(candidates[i].y2, candidates[j].y2);
            const inter = Math.max(0, xx2 - xx1) * Math.max(0, yy2 - yy1);
            const union = areas[i] + areas[j] - inter;
            const iou = inter / (union + 1e-6);
            if (iou > 0.5) candidates[j].suppressed = true;
        }
    }

    const panels = [];
    for (const p of keep) {
        const x1_img = (p.x1 - padLeft) / scale;
        const y1_img = (p.y1 - padTop) / scale;
        const x2_img = (p.x2 - padLeft) / scale;
        const y2_img = (p.y2 - padTop) / scale;
        panels.push({
            x: Math.max(0, x1_img),
            y: Math.max(0, y1_img),
            w: Math.min(width, x2_img) - Math.max(0, x1_img),
            h: Math.min(height, y2_img) - Math.max(0, y1_img),
            conf: p.conf
        });
    }
    return panels;
}

// ---------------------------------------------------------------------------
// Panel ordering
// ---------------------------------------------------------------------------
async function rankPanels(panels, bitmap) {
    if (panels.length <= 1 || !panelOrderSession) return panels;

    const { width, height } = bitmap;
    const crops = [];
    const validPanels = [];

    for (const p of panels) {
        const x1 = Math.max(0, Math.round(p.x));
        const y1 = Math.max(0, Math.round(p.y));
        const x2 = Math.min(width, Math.round(p.x + p.w));
        const y2 = Math.min(height, Math.round(p.y + p.h));
        if (x2 <= x1 || y2 <= y1) continue;

        const cropCanvas = new OffscreenCanvas(PANEL_CROP_SIZE, PANEL_CROP_SIZE);
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(bitmap, x1, y1, x2 - x1, y2 - y1, 0, 0, PANEL_CROP_SIZE, PANEL_CROP_SIZE);

        const cropData = cropCtx.getImageData(0, 0, PANEL_CROP_SIZE, PANEL_CROP_SIZE);
        const { data } = cropData;
        const norm = new Float32Array(3 * PANEL_CROP_SIZE * PANEL_CROP_SIZE);
        const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
        for (let i = 0; i < PANEL_CROP_SIZE * PANEL_CROP_SIZE; i++) {
            norm[0 * PANEL_CROP_SIZE * PANEL_CROP_SIZE + i] = (data[i * 4] / 255.0 - mean[0]) / std[0];
            norm[1 * PANEL_CROP_SIZE * PANEL_CROP_SIZE + i] = (data[i * 4 + 1] / 255.0 - mean[1]) / std[1];
            norm[2 * PANEL_CROP_SIZE * PANEL_CROP_SIZE + i] = (data[i * 4 + 2] / 255.0 - mean[2]) / std[2];
        }
        crops.push(norm);
        validPanels.push(p);
    }

    if (validPanels.length <= 1) return validPanels;

    const validN = validPanels.length;
    const imgAList = [], imgBList = [], posList = [];

    for (let i = 0; i < validN; i++) {
        for (let j = 0; j < validN; j++) {
            if (i === j) continue;
            imgAList.push(crops[i]);
            imgBList.push(crops[j]);
            posList.push(computePosFeatures(validPanels[i], validPanels[j], width, height));
        }
    }

    const batchSize = 32;
    const allLogits = [];
    for (let start = 0; start < imgAList.length; start += batchSize) {
        const end = Math.min(start + batchSize, imgAList.length);
        const count = end - start;
        const imgA = new Float32Array(count * 3 * PANEL_CROP_SIZE * PANEL_CROP_SIZE);
        const imgB = new Float32Array(count * 3 * PANEL_CROP_SIZE * PANEL_CROP_SIZE);
        const pos = new Float32Array(count * 12);

        for (let b = 0; b < count; b++) {
            imgA.set(imgAList[start + b], b * 3 * PANEL_CROP_SIZE * PANEL_CROP_SIZE);
            imgB.set(imgBList[start + b], b * 3 * PANEL_CROP_SIZE * PANEL_CROP_SIZE);
            pos.set(posList[start + b], b * 12);
        }

        const feed = {
            [panelOrderSession.inputNames[0]]: new ort.Tensor('float32', imgA, [count, 3, PANEL_CROP_SIZE, PANEL_CROP_SIZE]),
            [panelOrderSession.inputNames[1]]: new ort.Tensor('float32', imgB, [count, 3, PANEL_CROP_SIZE, PANEL_CROP_SIZE]),
            [panelOrderSession.inputNames[2]]: new ort.Tensor('float32', pos, [count, 12]),
        };

        const res = await panelOrderSession.run(feed);
        const logits = res[panelOrderSession.outputNames[0]].data;
        for (let b = 0; b < count; b++) allLogits.push(logits[b]);
    }

    const scores = new Float32Array(validN).fill(0);
    let idx = 0;
    for (let i = 0; i < validN; i++) {
        for (let j = 0; j < validN; j++) {
            if (i === j) continue;
            scores[i] += allLogits[idx++];
        }
    }

    const order = Array.from({ length: validN }, (_, i) => i);
    order.sort((a, b) => scores[b] - scores[a]);
    return order.map(i => validPanels[i]);
}

function computePosFeatures(a, b, w, h) {
    const ax = a.x / w, ay = a.y / h, aw = a.w / w, ah = a.h / h;
    const bx = b.x / w, by = b.y / h, bw = b.w / w, bh = b.h / h;
    const cxa = ax + aw / 2, cya = ay + ah / 2, cxb = bx + bw / 2, cyb = by + bh / 2;
    return [cxa, cya, aw, ah, cxb, cyb, bw, bh, cxa - cxb, cya - cyb, aw - bw, ah - bh];
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------
function assignBubblesToPanels(bubbles, panels) {
    const assignments = [];
    for (const b of bubbles) {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        let assigned = -1;
        for (let pi = 0; pi < panels.length; pi++) {
            const p = panels[pi];
            if (p.x <= cx && cx <= p.x + p.w && p.y <= cy && cy <= p.y + p.h) {
                assigned = pi;
                break;
            }
        }
        if (assigned === -1) {
            let bestArea = -1;
            const bx1 = b.x, by1 = b.y, bx2 = b.x + b.w, by2 = b.y + b.h;
            for (let pi = 0; pi < panels.length; pi++) {
                const p = panels[pi];
                const px1 = p.x, py1 = p.y, px2 = p.x + p.w, py2 = p.y + p.h;
                const ix1 = Math.max(bx1, px1), iy1 = Math.max(by1, py1), ix2 = Math.min(bx2, px2), iy2 = Math.min(by2, py2);
                if (ix1 < ix2 && iy1 < iy2) {
                    const area = (ix2 - ix1) * (iy2 - iy1);
                    if (area > bestArea) { bestArea = area; assigned = pi; }
                }
            }
        }
        if (assigned === -1) {
            let minDist = Infinity;
            for (let pi = 0; pi < panels.length; pi++) {
                const p = panels[pi], pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
                const dist = Math.hypot(cx - pcx, cy - pcy);
                if (dist < minDist) { minDist = dist; assigned = pi; }
            }
        }
        assignments.push(assigned);
    }
    return assignments;
}

// ---------------------------------------------------------------------------
// ReaderNet
// ---------------------------------------------------------------------------
async function sortBubblesWithReaderNet(bubbles, panels, assignments, bitmap) {
    if (!readernetSession || bubbles.length < 2) return mangaOrderSort(bubbles);
    const { width, height } = bitmap;
    const normBubbles = bubbles.map(b => ({ x: b.x / width, y: b.y / height, w: b.w / width, h: b.h / height, original: b }));
    const normPanels = panels.map(p => ({ x: p.x / width, y: p.y / height, w: p.w / width, h: p.h / height }));

    const ratio = PAGE_H / height, newW = Math.min(Math.round(width * ratio), PAGE_W), padLeft = Math.floor((PAGE_W - newW) / 2);
    const pageCanvas = new OffscreenCanvas(PAGE_W, PAGE_H), pageCtx = pageCanvas.getContext('2d');
    pageCtx.fillStyle = '#000000'; pageCtx.fillRect(0, 0, PAGE_W, PAGE_H);
    pageCtx.drawImage(bitmap, padLeft, 0, newW, PAGE_H);
    const pageData = pageCtx.getImageData(0, 0, PAGE_W, PAGE_H), pageGray = new Float32Array(PAGE_W * PAGE_H);
    for (let i = 0; i < PAGE_W * PAGE_H; i++) pageGray[i] = (pageData.data[i * 4] * 0.299 + pageData.data[i * 4 + 1] * 0.587 + pageData.data[i * 4 + 2] * 0.114) / 255.0;

    const bubbleCrops = [];
    for (const b of normBubbles) {
        const x1 = Math.max(0, Math.round(b.x * width)), y1 = Math.max(0, Math.round(b.y * height)), x2 = Math.min(width, Math.round((b.x + b.w) * width)), y2 = Math.min(height, Math.round((b.y + b.h) * height));
        if (x2 <= x1 || y2 <= y1) { bubbleCrops.push(new Float32Array(BUBBLE_CROP_SIZE * BUBBLE_CROP_SIZE).fill(0)); continue; }
        const cropCanvas = new OffscreenCanvas(BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(bitmap, x1, y1, x2 - x1, y2 - y1, 0, 0, BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE);
        const cropData = cropCtx.getImageData(0, 0, BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), cropGray = new Float32Array(BUBBLE_CROP_SIZE * BUBBLE_CROP_SIZE);
        for (let i = 0; i < BUBBLE_CROP_SIZE * BUBBLE_CROP_SIZE; i++) cropGray[i] = (cropData.data[i * 4] * 0.299 + cropData.data[i * 4 + 1] * 0.587 + cropData.data[i * 4 + 2] * 0.114) / 255.0;
        bubbleCrops.push(cropGray);
    }

    const numBubbles = bubbles.length, numPanels = panels.length || 1;
    const finalPanels = numPanels > 0 ? normPanels : [{ x: 0, y: 0, w: 1, h: 1 }];
    const finalAssignments = assignments.map(a => a < 0 ? 0 : a);
    const maxBubbles = Math.max(numBubbles, 1), maxPanels = Math.max(numPanels, 1);

    const geoms = new Float32Array(maxBubbles * 4), bubblePanels = new BigInt64Array(maxBubbles), cropsArr = new Float32Array(maxBubbles * BUBBLE_CROP_SIZE * BUBBLE_CROP_SIZE), panelsArr = new Float32Array(maxPanels * 4), panelMask = new Uint8Array(maxPanels), bubbleMask = new Uint8Array(maxBubbles);

    for (let i = 0; i < numBubbles; i++) {
        geoms[i * 4 + 0] = normBubbles[i].x; geoms[i * 4 + 1] = normBubbles[i].y; geoms[i * 4 + 2] = normBubbles[i].w; geoms[i * 4 + 3] = normBubbles[i].h;
        bubblePanels[i] = BigInt(finalAssignments[i]); bubbleMask[i] = 0;
        for (let j = 0; j < BUBBLE_CROP_SIZE * BUBBLE_CROP_SIZE; j++) cropsArr[i * BUBBLE_CROP_SIZE * BUBBLE_CROP_SIZE + j] = bubbleCrops[i][j];
    }
    for (let i = numBubbles; i < maxBubbles; i++) { bubbleMask[i] = 1; bubblePanels[i] = BigInt(0); }
    for (let i = 0; i < finalPanels.length; i++) { panelsArr[i * 4 + 0] = finalPanels[i].x; panelsArr[i * 4 + 1] = finalPanels[i].y; panelsArr[i * 4 + 2] = finalPanels[i].w; panelsArr[i * 4 + 3] = finalPanels[i].h; panelMask[i] = 0; }
    for (let i = finalPanels.length; i < maxPanels; i++) panelMask[i] = 1;

    const feed = { images: new ort.Tensor('float32', pageGray, [1, 1, PAGE_H, PAGE_W]), panels: new ort.Tensor('float32', panelsArr, [1, maxPanels, 4]), bubbles: new ort.Tensor('float32', geoms, [1, maxBubbles, 4]), bubble_panels: new ort.Tensor('int64', bubblePanels, [1, maxBubbles]), bubble_crops: new ort.Tensor('float32', cropsArr, [1, maxBubbles, 1, BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE]), panel_mask: new ort.Tensor('bool', panelMask, [1, maxPanels]), bubble_mask: new ort.Tensor('bool', bubbleMask, [1, maxBubbles]) };
    const results = await readernetSession.run(feed);
    const scores = results[readernetSession.outputNames[0]].data;

    const panelGroups = {};
    for (let i = 0; i < numBubbles; i++) { const p = finalAssignments[i]; if (!panelGroups[p]) panelGroups[p] = []; panelGroups[p].push(i); }
    const sortedIndices = [];
    for (let pi = 0; pi < finalPanels.length; pi++) { const group = panelGroups[pi] || []; if (group.length === 0) continue; group.sort((a, b) => scores[a] - scores[b]); sortedIndices.push(...group); }
    return sortedIndices.map(i => bubbles[i]);
}

function mangaOrderSort(boxes) {
    if (boxes.length === 0) return [];
    const sorted = [...boxes]; sorted.sort((a, b) => a.y - b.y);
    const rows = [];
    for (const box of sorted) {
        let added = false;
        if (rows.length > 0) { const lastRow = rows[rows.length - 1]; if (Math.abs(box.y - lastRow[0].y) < 100) { lastRow.push(box); added = true; } }
        if (!added) rows.push([box]);
    }
    const result = [];
    for (const row of rows) { row.sort((a, b) => b.x - a.x); result.push(...row); }
    return result;
}