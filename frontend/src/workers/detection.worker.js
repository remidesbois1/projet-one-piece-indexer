import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

// ---------------------------------------------------------------------------
// Model URLs
// ---------------------------------------------------------------------------
const ONE_SHOT_MODEL_BASE = 'https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/resolve/main';
const BUBBLE_MODEL_PATH = `${ONE_SHOT_MODEL_BASE}/bubble_detector.onnx`;
const PANEL_MODEL_PATH = `${ONE_SHOT_MODEL_BASE}/panel_detector.onnx`;
const PANEL_ORDER_PATH = `${ONE_SHOT_MODEL_BASE}/panel_order.onnx`;
const BUBBLE_ORDER_PATH = `${ONE_SHOT_MODEL_BASE}/bubble_order.onnx`;

const BUBBLE_SCORE_THRESHOLD = 0.25;
const BUBBLE_DUPLICATE_IOU_THRESHOLD = 0.9;

let bubbleSession = null;
let panelSession = null;
let panelOrderSession = null;
let bubbleOrderSession = null;

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
            if (bubbleSession && panelSession && panelOrderSession && bubbleOrderSession) {
                self.postMessage({ status: 'ready' });
                return;
            }

            console.log("[Worker] Loading models...");

            const models = [
                { path: BUBBLE_MODEL_PATH, name: 'Bubble Detector' },
                { path: PANEL_MODEL_PATH, name: 'Panel Detector' },
                { path: PANEL_ORDER_PATH, name: 'Panel Order' },
                { path: BUBBLE_ORDER_PATH, name: 'Bubble Order' }
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
            const buf3 = await fetchModel(PANEL_ORDER_PATH, updateGlobalProgress);
            panelOrderSession = await ort.InferenceSession.create(buf3, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            totalLoaded += buf3.byteLength;
            console.log("[Worker] Panel order model loaded");

            // 4. Bubble Order
            const buf4 = await fetchModel(BUBBLE_ORDER_PATH, updateGlobalProgress);
            bubbleOrderSession = await ort.InferenceSession.create(buf4, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            totalLoaded += buf4.byteLength;
            console.log("[Worker] Bubble order model loaded");

            self.postMessage({ status: 'download_progress', progress: 100 });
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker] Init Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'run-positions-only' && imageBlob) {
        if (!bubbleSession) return;
        try {
            const bitmap = await createImageBitmap(imageBlob);
            const { height: inputH, width: inputW } = getImageInputSize(bubbleSession, 800, 800);
            const { inputTensor, scale, padX, padY } = preprocessBubble(bitmap, inputH, inputW);
            const bubbleFeeds = { [bubbleSession.inputNames[0]]: inputTensor };
            const bubbleResults = await bubbleSession.run(bubbleFeeds);
            const bubbleOutput = bubbleResults[bubbleSession.outputNames[0]].data;
            const boxes = simplifyPostProcess(bubbleOutput, scale, padX, padY);
            self.postMessage({ status: 'complete', boxes });
        } catch (err) {
            console.error("[Worker] Positions-only run error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!bubbleSession) return;
        try {
            const bitmap = await createImageBitmap(imageBlob);
            const { width: imgW, height: imgH } = bitmap;

            // 1. Detect bubbles
            const { height: inputH, width: inputW } = getImageInputSize(bubbleSession, 800, 800);
            const { inputTensor, scale, padX, padY } = preprocessBubble(bitmap, inputH, inputW);
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

            if (panels.length > 0 && panelOrderSession && bubbleOrderSession) {
                // 3. Sort panels by reading order
                const sortedPanels = await rankPanels(panels, bitmap);

                // 4. Assign bubbles to panels
                const assignments = assignBubblesToPanels(boxes, sortedPanels);

                // 5. Sort bubbles within each panel using the new reading-order ranker
                sortedBoxes = await sortBubblesWithReadingOrder(boxes, sortedPanels, assignments, bitmap);
            } else {
                // Fallback when no panel could be detected on the page.
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
function getImageInputSize(session, fallbackH, fallbackW) {
    try {
        const inputName = session.inputNames?.[0];
        const dims = session.inputMetadata?.[inputName]?.dims;
        const height = Number(dims?.[2]);
        const width = Number(dims?.[3]);
        if (Number.isFinite(height) && Number.isFinite(width) && height > 0 && width > 0) {
            return { height, width };
        }
    } catch (e) {
        console.warn("[Worker] Could not read detector input dims, using fallback", e);
    }
    return { height: fallbackH, width: fallbackW };
}

function preprocessBubble(bitmap, targetH, targetW) {
    const { width, height } = bitmap;
    const scale = Math.min(targetW / width, targetH / height);
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    const padX = (targetW - newW) / 2;
    const padY = (targetH - newH) / 2;

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(bitmap, padX, padY, newW, newH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    const { data } = imageData;
    const pixelCount = targetW * targetH;
    const float32Data = new Float32Array(3 * pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        float32Data[i] = data[i * 4] / 255.0;
        float32Data[pixelCount + i] = data[i * 4 + 1] / 255.0;
        float32Data[2 * pixelCount + i] = data[i * 4 + 2] / 255.0;
    }

    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, targetH, targetW]);
    return { inputTensor, scale, padX, padY };
}

function simplifyPostProcess(data, scale, padX, padY) {
    const boxes = [];
    for (let i = 0; i < data.length; i += 6) {
        const score = data[i + 4];
        if (score < BUBBLE_SCORE_THRESHOLD) continue;

        let x1 = (data[i] - padX) / scale;
        let y1 = (data[i + 1] - padY) / scale;
        let x2 = (data[i + 2] - padX) / scale;
        let y2 = (data[i + 3] - padY) / scale;
        const w = Math.round(x2 - x1);
        const h = Math.round(y2 - y1);

        if (w <= 0 || h <= 0) continue;

        boxes.push({
            x: Math.round(x1),
            y: Math.round(y1),
            w,
            h,
            score: score
        });
    }

    return suppressDuplicateBoxes(boxes, BUBBLE_DUPLICATE_IOU_THRESHOLD);
}

function boxArea(box) {
    return Math.max(0, box.w) * Math.max(0, box.h);
}

function boxIou(a, b) {
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;

    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const union = boxArea(a) + boxArea(b) - intersection;
    return union > 0 ? intersection / union : 0;
}

function suppressDuplicateBoxes(boxes, iouThreshold) {
    const sorted = boxes
        .map((box, index) => ({ ...box, index }))
        .sort((a, b) => b.score - a.score);
    const kept = [];

    for (const box of sorted) {
        if (kept.some(keptBox => boxIou(box, keptBox) >= iouThreshold)) continue;
        kept.push(box);
    }

    return kept
        .sort((a, b) => a.index - b.index)
        .map(box => ({ x: box.x, y: box.y, w: box.w, h: box.h, score: box.score }));
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
    return rankItemsByPairwiseModel(
        panels,
        panelOrderSession,
        (a, b) => pairFeatures(a, b, width, height)
    );
}

function safeDiv(a, b) {
    return b === 0 ? 0 : a / b;
}

function boxRight(box) {
    return box.x + box.w;
}

function boxBottom(box) {
    return box.y + box.h;
}

function boxCenterX(box) {
    return box.x + box.w / 2;
}

function boxCenterY(box) {
    return box.y + box.h / 2;
}

function intervalOverlap(a1, a2, b1, b2) {
    return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function boxFeatures(box, width, height) {
    const area = Math.max(1, width * height);
    return [
        safeDiv(box.x, width),
        safeDiv(box.y, height),
        safeDiv(boxRight(box), width),
        safeDiv(boxBottom(box), height),
        safeDiv(boxCenterX(box), width),
        safeDiv(boxCenterY(box), height),
        safeDiv(box.w, width),
        safeDiv(box.h, height),
        safeDiv(box.w * box.h, area),
        safeDiv(box.w, box.h),
    ];
}

function pairFeatures(a, b, width, height) {
    const aCx = boxCenterX(a);
    const aCy = boxCenterY(a);
    const bCx = boxCenterX(b);
    const bCy = boxCenterY(b);
    const dx = safeDiv(aCx - bCx, width);
    const dy = safeDiv(aCy - bCy, height);
    const xOverlap = safeDiv(
        intervalOverlap(a.x, boxRight(a), b.x, boxRight(b)),
        Math.min(a.w, b.w)
    );
    const yOverlap = safeDiv(
        intervalOverlap(a.y, boxBottom(a), b.y, boxBottom(b)),
        Math.min(a.h, b.h)
    );
    const sameReadingBand = yOverlap > 0.35 || Math.abs(aCy - bCy) <= Math.max(a.h, b.h) * 0.35;
    const rtlBefore = sameReadingBand ? aCx > bCx : aCy < bCy;
    const ltrBefore = sameReadingBand ? aCx < bCx : aCy < bCy;

    return [
        ...boxFeatures(a, width, height),
        ...boxFeatures(b, width, height),
        dx,
        dy,
        Math.abs(dx),
        Math.abs(dy),
        safeDiv(a.x - b.x, width),
        safeDiv(a.y - b.y, height),
        safeDiv(boxRight(a) - boxRight(b), width),
        safeDiv(boxBottom(a) - boxBottom(b), height),
        safeDiv(a.w - b.w, width),
        safeDiv(a.h - b.h, height),
        Math.hypot(dx, dy),
        safeDiv(Math.atan2(dy, dx), Math.PI),
        xOverlap,
        yOverlap,
        aCx > bCx ? 1 : 0,
        aCy < bCy ? 1 : 0,
        yOverlap > 0.35 ? 1 : 0,
        xOverlap > 0.35 ? 1 : 0,
        sameReadingBand ? 1 : 0,
        rtlBefore ? 1 : 0,
        ltrBefore ? 1 : 0,
        (rtlBefore ? 1 : -1) * (sameReadingBand ? 1 : 0.5),
    ];
}

function bubblePairFeatures(a, b, pageWidth, pageHeight, panelBox) {
    const panelWidth = Math.max(1, panelBox.w);
    const panelHeight = Math.max(1, panelBox.h);
    const relativeA = {
        x: a.x - panelBox.x,
        y: a.y - panelBox.y,
        w: a.w,
        h: a.h,
    };
    const relativeB = {
        x: b.x - panelBox.x,
        y: b.y - panelBox.y,
        w: b.w,
        h: b.h,
    };
    return [
        ...pairFeatures(a, b, pageWidth, pageHeight),
        ...pairFeatures(relativeA, relativeB, panelWidth, panelHeight),
        ...boxFeatures(panelBox, pageWidth, pageHeight),
    ];
}

async function runPairwiseModel(session, featureRows) {
    if (!featureRows.length) return [];
    const featureCount = featureRows[0].length;
    const input = new Float32Array(featureRows.length * featureCount);
    for (let row = 0; row < featureRows.length; row++) {
        input.set(featureRows[row], row * featureCount);
    }
    const feed = {
        [session.inputNames[0]]: new ort.Tensor('float32', input, [featureRows.length, featureCount]),
    };
    const result = await session.run(feed);
    return Array.from(result[session.outputNames[0]].data);
}

async function rankItemsByPairwiseModel(items, session, featureBuilder) {
    if (items.length <= 1 || !session) return [...items];

    const pairs = [];
    const featureRows = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = 0; j < items.length; j++) {
            if (i === j) continue;
            pairs.push([i, j]);
            featureRows.push(featureBuilder(items[i], items[j]));
        }
    }

    const probabilities = await runPairwiseModel(session, featureRows);
    const scores = new Float32Array(items.length).fill(0);
    for (let index = 0; index < pairs.length; index++) {
        const [i] = pairs[index];
        scores[i] += probabilities[index];
    }

    return Array.from({ length: items.length }, (_, index) => index)
        .sort((a, b) => scores[b] - scores[a] || a - b)
        .map(index => items[index]);
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
// Reading-order rankers
// ---------------------------------------------------------------------------
async function sortBubblesWithReadingOrder(bubbles, panels, assignments, bitmap) {
    if (!bubbleOrderSession || bubbles.length < 2) return mangaOrderSort(bubbles);

    const { width, height } = bitmap;
    const panelGroups = new Map();
    for (let i = 0; i < bubbles.length; i++) {
        const panelIndex = assignments[i] < 0 ? 0 : assignments[i];
        if (!panelGroups.has(panelIndex)) panelGroups.set(panelIndex, []);
        panelGroups.get(panelIndex).push(bubbles[i]);
    }

    const sorted = [];
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
        const group = panelGroups.get(panelIndex) || [];
        if (!group.length) continue;
        const panel = panels[panelIndex];
        const orderedGroup = await rankItemsByPairwiseModel(
            group,
            bubbleOrderSession,
            (a, b) => bubblePairFeatures(a, b, width, height, panel)
        );
        sorted.push(...orderedGroup);
    }

    return sorted.length === bubbles.length ? sorted : mangaOrderSort(bubbles);
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
