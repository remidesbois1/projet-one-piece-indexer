import * as ort from 'onnxruntime-web';
import modelRegistry from '@poneglyph/shared/model-registry.json';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

// ---------------------------------------------------------------------------
// Model URLs
// ---------------------------------------------------------------------------
const READERNET_ARTIFACT = modelRegistry.models['readernet-reading-order'].artifact;
const READERNET_MODEL_REVISION = READERNET_ARTIFACT.revision;
const READERNET_MODEL_BASE = `https://huggingface.co/${READERNET_ARTIFACT.repository}/resolve/${READERNET_MODEL_REVISION}`;
const BUBBLE_MODEL_PATH = `${READERNET_MODEL_BASE}/bubble_detector.onnx`;
const PANEL_MODEL_PATH = `${READERNET_MODEL_BASE}/panel_detector.onnx`;
const ORDERING_MODEL_PATH = `${READERNET_MODEL_BASE}/ordering.onnx`;

const BUBBLE_SCORE_THRESHOLD = 0.45;
const BUBBLE_DUPLICATE_IOU_THRESHOLD = 0.9;
const PANEL_ORDER_FEATURE_COUNT = 96;
const BUBBLE_ORDER_FEATURE_COUNT = 102;

let bubbleSession = null;
let panelSession = null;
let orderingSession = null;
const activeRequestIds = new Set();
const cancelledRequestIds = new Set();

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------
async function fetchModel(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
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
    const { type, requestId, imageBlob, debug = false } = event.data;

    if (type === 'cancel') {
        if (activeRequestIds.has(requestId)) cancelledRequestIds.add(requestId);
        return;
    }

    if (type === 'init') {
        try {
            if (
                bubbleSession &&
                panelSession &&
                orderingSession
            ) {
                self.postMessage({ status: 'ready' });
                return;
            }

            console.log("[Worker] Loading models...");

            const models = [
                { path: BUBBLE_MODEL_PATH, name: 'Bubble Detector' },
                { path: PANEL_MODEL_PATH, name: 'Panel Detector' },
                { path: ORDERING_MODEL_PATH, name: 'ReaderNet Ordering' }
            ];

            const sizes = await Promise.all(models.map(async (m) => {
                try {
                    const resp = await fetch(m.path, { method: 'HEAD' });
                    return parseInt(resp.headers.get('content-length') || '0', 10);
                } catch { return 0; }
            }));

            const totalSize = sizes.reduce((a, b) => a + b, 0);
            let totalLoaded = 0;

            const updateGlobalProgress = (loadedInFile) => {
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

            // 3. Fused panel + intra-panel bubble ordering
            const buf3 = await fetchModel(ORDERING_MODEL_PATH, updateGlobalProgress);
            orderingSession = await ort.InferenceSession.create(buf3, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            totalLoaded += buf3.byteLength;
            console.log("[Worker] ReaderNet ordering model loaded");

            self.postMessage({ status: 'download_progress', progress: 100 });
            self.postMessage({ status: 'ready' });
        } catch (err) {
            console.error("[Worker] Init Error:", err);
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'run-positions-only' && imageBlob) {
        if (!bubbleSession) return;
        activeRequestIds.add(requestId);
        try {
            const bitmap = await createImageBitmap(imageBlob);
            const { height: inputH, width: inputW } = getImageInputSize(bubbleSession, 800, 800);
            const { inputTensor, scale, padX, padY } = preprocessBubble(bitmap, inputH, inputW);
            const bubbleFeeds = { [bubbleSession.inputNames[0]]: inputTensor };
            const bubbleResults = await bubbleSession.run(bubbleFeeds);
            const bubbleOutput = bubbleResults[bubbleSession.outputNames[0]].data;
            const boxes = simplifyPostProcess(bubbleOutput, scale, padX, padY);
            if (cancelledRequestIds.has(requestId)) return;
            self.postMessage({ status: 'complete', requestId, boxes });
        } catch (err) {
            if (cancelledRequestIds.has(requestId)) return;
            console.error("[Worker] Positions-only run error:", err);
            self.postMessage({ status: 'error', requestId, error: err.message });
        } finally {
            activeRequestIds.delete(requestId);
            cancelledRequestIds.delete(requestId);
        }
    }

    if (type === 'run' && imageBlob) {
        if (!bubbleSession) return;
        activeRequestIds.add(requestId);
        try {
            const bitmap = await createImageBitmap(imageBlob);

            // 1. Detect bubbles
            const { height: inputH, width: inputW } = getImageInputSize(bubbleSession, 800, 800);
            const { inputTensor, scale, padX, padY } = preprocessBubble(bitmap, inputH, inputW);
            const bubbleFeeds = { [bubbleSession.inputNames[0]]: inputTensor };
            const bubbleResults = await bubbleSession.run(bubbleFeeds);
            const bubbleOutput = bubbleResults[bubbleSession.outputNames[0]].data;
            const boxes = simplifyPostProcess(bubbleOutput, scale, padX, padY);

            if (boxes.length <= 1) {
                if (cancelledRequestIds.has(requestId)) return;
                self.postMessage({
                    status: 'complete',
                    requestId,
                    boxes,
                    debug: debug ? buildReadingOrderDebug({
                        mode: 'single_or_empty',
                        rawBubbles: boxes,
                        finalBoxes: boxes,
                        panels: [],
                        contexts: new Map(),
                        assignmentDetails: []
                    }) : undefined
                });
                return;
            }

            let sortedBoxes;
            let sortedPanels = [];
            let assignmentDetails = [];
            let currentOrder = null;
            let readingOrderMode = 'current_pipeline';

            // 2. Detect panels
            const panels = await detectPanels(bitmap);

            if (panels.length > 0 && orderingSession) {
                // 3. Sort panels by reading order
                sortedPanels = await rankPanels(panels, bitmap);

                // 4. Assign bubbles to panels
                assignmentDetails = assignBubblesToPanelsDetailed(boxes, sortedPanels, bitmap);

                // 5. Sort bubbles independently inside each panel.
                currentOrder = await sortBubblesWithReadingOrderDetails(
                    boxes,
                    sortedPanels,
                    assignmentDetails,
                    bitmap
                );
                sortedBoxes = currentOrder.boxes;
                console.log("[Worker] Reading order mode: readernet_panel_constrained");
                readingOrderMode = 'readernet_panel_constrained';
            } else {
                // Fallback when no panel could be detected on the page.
                sortedBoxes = mangaOrderSort(boxes);
                console.log("[Worker] Reading order mode: panel_less_fallback");
                readingOrderMode = 'panel_less_fallback';
            }

            if (cancelledRequestIds.has(requestId)) return;
            self.postMessage({
                status: 'complete',
                requestId,
                boxes: sortedBoxes,
                debug: debug ? buildReadingOrderDebug({
                    mode: readingOrderMode,
                    rawBubbles: boxes,
                    finalBoxes: sortedBoxes,
                    panels: sortedPanels,
                    contexts: currentOrder?.contexts || new Map(),
                    assignmentDetails
                }) : undefined
            });
        } catch (err) {
            if (cancelledRequestIds.has(requestId)) return;
            console.error("[Worker] Run Error:", err);
            self.postMessage({ status: 'error', requestId, error: err.message });
        } finally {
            activeRequestIds.delete(requestId);
            cancelledRequestIds.delete(requestId);
        }
    }
});

// ---------------------------------------------------------------------------
// Bubble detector preprocessing
// ---------------------------------------------------------------------------
function getImageInputSize(session, fallbackH, fallbackW) {
    try {
        const inputName = session.inputNames?.[0];
        const metadata = session.inputMetadata;
        const inputMetadata = Array.isArray(metadata)
            ? metadata.find(item => item?.name === inputName) ?? metadata[0]
            : metadata?.[inputName];
        const dims = inputMetadata?.shape ?? inputMetadata?.dims;
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

function roundDebugNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric * 1000) / 1000 : null;
}

function debugBox(box) {
    if (!box) return null;
    return {
        x: roundDebugNumber(box.x),
        y: roundDebugNumber(box.y),
        w: roundDebugNumber(box.w),
        h: roundDebugNumber(box.h),
        score: roundDebugNumber(box.score ?? box.conf)
    };
}

function buildReadingOrderDebug({
    mode,
    rawBubbles,
    finalBoxes,
    panels,
    contexts,
    assignmentDetails
}) {
    const finalIndexByBox = new Map(finalBoxes.map((box, index) => [box, index]));
    const rawIndexByBox = new Map(rawBubbles.map((box, index) => [box, index]));
    const assignmentByBox = new Map(
        rawBubbles.map((box, index) => [box, assignmentDetails[index] || null])
    );

    return {
        mode,
        modelRevision: READERNET_MODEL_REVISION,
        bubbleThreshold: BUBBLE_SCORE_THRESHOLD,
        panelCount: panels.length,
        bubbleCount: finalBoxes.length,
        panels: panels.map((panel, index) => ({
            order: index + 1,
            id: panel.panelId ?? panel.id ?? `panel_${index}`,
            score: roundDebugNumber(panel.score ?? panel.conf),
            box: debugBox(panel)
        })),
        bubbles: finalBoxes.map((box, index) => {
            const context = contexts.get(box);
            const assignment = context?.assignment || assignmentByBox.get(box);
            return {
                order: index + 1,
                rawIndex: (rawIndexByBox.get(box) ?? index) + 1,
                finalIndex: (finalIndexByBox.get(box) ?? index) + 1,
                score: roundDebugNumber(box.score ?? box.conf),
                box: debugBox(box),
                panelOrder: Number.isInteger(context?.predictedPanelIndex)
                    ? context.predictedPanelIndex + 1
                    : null,
                panelId: context?.predictedPanelId ?? assignment?.panelId ?? null,
                localOrder: Number.isInteger(context?.predictedLocalOrder)
                    ? context.predictedLocalOrder + 1
                    : null,
                assignmentReason: assignment?.reason ?? null,
                centerInside: assignment?.centerInside ?? null,
                overlapRatio: roundDebugNumber(assignment?.overlapRatio),
                secondBestPanelMargin: roundDebugNumber(assignment?.secondBestPanelMargin)
            };
        })
    };
}

// ---------------------------------------------------------------------------
// Panel detection (YOLO)
// ---------------------------------------------------------------------------
const PANEL_SCORE_THRESHOLD = 0.25;

async function detectPanels(bitmap) {
    if (!panelSession) return [];

    const { width, height } = bitmap;
    const { height: inH, width: inW } = getImageInputSize(panelSession, 1504, 1504);

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
    let numPreds, numFeatures, isRowMajor;
    if (d.length === 3) {
        if (d[1] > d[2]) {
            numPreds = d[1];
            numFeatures = d[2];
            isRowMajor = true;
        } else {
            numPreds = d[2];
            numFeatures = d[1];
            isRowMajor = false;
        }
    } else {
        return [];
    }

    const raw = output.data;
    const candidates = [];
    for (let col = 0; col < numPreds; col++) {
        const conf = readYoloOutputFeature(raw, col, 4, numPreds, numFeatures, isRowMajor);
        if (conf < PANEL_SCORE_THRESHOLD) continue;

        const box = parseYoloPanelBox(raw, col, numPreds, numFeatures, isRowMajor);
        if (!box) continue;

        candidates.push({ ...box, conf, idx: col });
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
        const x = Math.max(0, x1_img);
        const y = Math.max(0, y1_img);
        const clippedX2 = Math.min(width, x2_img);
        const clippedY2 = Math.min(height, y2_img);
        const w = clippedX2 - x;
        const h = clippedY2 - y;
        if (w <= 1 || h <= 1) continue;

        panels.push({
            x,
            y,
            w,
            h,
            conf: p.conf,
            polygon: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        });
    }
    return panels;
}

function readYoloOutputFeature(raw, predIndex, featureIndex, numPreds, numFeatures, isRowMajor) {
    if (featureIndex >= numFeatures) return 0;
    return isRowMajor
        ? raw[predIndex * numFeatures + featureIndex]
        : raw[featureIndex * numPreds + predIndex];
}

function parseYoloPanelBox(raw, predIndex, numPreds, numFeatures, isRowMajor) {
    const a = readYoloOutputFeature(raw, predIndex, 0, numPreds, numFeatures, isRowMajor);
    const b = readYoloOutputFeature(raw, predIndex, 1, numPreds, numFeatures, isRowMajor);
    const c = readYoloOutputFeature(raw, predIndex, 2, numPreds, numFeatures, isRowMajor);
    const d = readYoloOutputFeature(raw, predIndex, 3, numPreds, numFeatures, isRowMajor);

    if (![a, b, c, d].every(Number.isFinite)) return null;

    // Ultralytics ONNX exports with nms=True emit [x1, y1, x2, y2, score, class].
    // Raw detector heads emit [cx, cy, w, h, ...]. The current panel artifact is
    // [1, 300, 6], so treating it as cx/cy/w/h creates nonsense rectangles.
    const isNmsOutput = numFeatures >= 6 && numPreds <= 1000;
    if (isNmsOutput) {
        if (c <= a || d <= b) return null;
        return { x1: a, y1: b, x2: c, y2: d };
    }

    const x1 = a - c / 2;
    const y1 = b - d / 2;
    const x2 = a + c / 2;
    const y2 = b + d / 2;
    if (x2 <= x1 || y2 <= y1) return null;
    return { x1, y1, x2, y2 };
}

// ---------------------------------------------------------------------------
// Panel ordering
// ---------------------------------------------------------------------------
async function rankPanels(panels, bitmap) {
    if (panels.length <= 1 || !orderingSession) return panels;

    const { width, height } = bitmap;
    return rankItemsByPairwiseModel(
        panels,
        'panel',
        (a, b) => panelPairFeatures(a, b, width, height)
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

function intersectionArea(a, b) {
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(boxRight(a), boxRight(b));
    const iy2 = Math.min(boxBottom(a), boxBottom(b));
    return Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
}

function canonicalPanelPolygon(panel, width, height) {
    const source = Array.isArray(panel.polygon) && panel.polygon.length === 4
        ? panel.polygon
        : [
            [panel.x, panel.y],
            [boxRight(panel), panel.y],
            [boxRight(panel), boxBottom(panel)],
            [panel.x, boxBottom(panel)],
        ];
    const polygon = source.map(([x, y]) => [
        Math.max(0, Math.min(width, x)) / Math.max(1, width),
        Math.max(0, Math.min(height, y)) / Math.max(1, height),
    ]);
    const center = polygon.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
        .map(value => value / polygon.length);
    polygon.sort((a, b) => (
        Math.atan2(a[1] - center[1], a[0] - center[0])
        - Math.atan2(b[1] - center[1], b[0] - center[0])
    ));
    let start = 0;
    for (let index = 1; index < polygon.length; index++) {
        if (polygon[index][0] + polygon[index][1] < polygon[start][0] + polygon[start][1]) start = index;
    }
    return [...polygon.slice(start), ...polygon.slice(0, start)];
}

function polygonArea(polygon) {
    let twiceArea = 0;
    for (let index = 0; index < polygon.length; index++) {
        const next = (index + 1) % polygon.length;
        twiceArea += polygon[index][0] * polygon[next][1] - polygon[index][1] * polygon[next][0];
    }
    return Math.abs(twiceArea) * 0.5;
}

function polygonDescriptor(polygon) {
    const xs = polygon.map(point => point[0]);
    const ys = polygon.map(point => point[1]);
    const low = [Math.min(...xs), Math.min(...ys)];
    const high = [Math.max(...xs), Math.max(...ys)];
    const center = [xs.reduce((a, b) => a + b, 0) / 4, ys.reduce((a, b) => a + b, 0) / 4];
    const size = [high[0] - low[0], high[1] - low[1]];
    return [
        ...polygon.flat(), ...center, ...low, ...high, ...size,
        polygonArea(polygon), safeDiv(size[0], Math.max(size[1], 1e-6)),
        polygon[1][1] - polygon[0][1], polygon[2][1] - polygon[3][1],
        polygon[3][0] - polygon[0][0], polygon[2][0] - polygon[1][0],
    ];
}

function panelPairFeatures(a, b, width, height) {
    const da = polygonDescriptor(canonicalPanelPolygon(a, width, height));
    const db = polygonDescriptor(canonicalPanelPolygon(b, width, height));
    const dx = da[8] - db[8];
    const dy = da[9] - db[9];
    const xOverlap = Math.max(0, Math.min(da[12], db[12]) - Math.max(da[10], db[10]));
    const yOverlap = Math.max(0, Math.min(da[13], db[13]) - Math.max(da[11], db[11]));
    const diff = da.map((value, index) => value - db[index]);
    return [
        ...da, ...db, ...diff, ...diff.map(Math.abs),
        dx, dy, Math.abs(dx), Math.abs(dy),
        safeDiv(xOverlap, Math.max(Math.min(da[14], db[14]), 1e-6)),
        safeDiv(yOverlap, Math.max(Math.min(da[15], db[15]), 1e-6)),
        da[8] > db[8] ? 1 : 0, da[9] < db[9] ? 1 : 0,
    ];
}

function normalizedBubbleDescriptor(bubble, panelPolygon, pageWidth, pageHeight) {
    const bbox = [
        bubble.x / pageWidth, bubble.y / pageHeight,
        boxRight(bubble) / pageWidth, boxBottom(bubble) / pageHeight,
    ];
    const [x1, y1, x2, y2] = bbox;
    const cx = (x1 + x2) * 0.5;
    const cy = (y1 + y2) * 0.5;
    const width = x2 - x1;
    const height = y2 - y1;
    const xs = panelPolygon.map(point => point[0]);
    const ys = panelPolygon.map(point => point[1]);
    const low = [Math.min(...xs), Math.min(...ys)];
    const panelSize = [Math.max(Math.max(...xs) - low[0], 1e-6), Math.max(Math.max(...ys) - low[1], 1e-6)];
    return [
        ...bbox, cx, cy, width, height, width * height, safeDiv(width, Math.max(height, 1e-6)),
        (x1 - low[0]) / panelSize[0], (y1 - low[1]) / panelSize[1],
        (x2 - low[0]) / panelSize[0], (y2 - low[1]) / panelSize[1],
        (cx - low[0]) / panelSize[0], (cy - low[1]) / panelSize[1],
        width / panelSize[0], height / panelSize[1],
    ];
}

function bubblePairFeatures(a, b, pageWidth, pageHeight, panel) {
    const polygon = canonicalPanelPolygon(panel, pageWidth, pageHeight);
    const da = normalizedBubbleDescriptor(a, polygon, pageWidth, pageHeight);
    const db = normalizedBubbleDescriptor(b, polygon, pageWidth, pageHeight);
    const dx = da[4] - db[4];
    const dy = da[5] - db[5];
    const xOverlap = safeDiv(
        Math.max(0, Math.min(da[2], db[2]) - Math.max(da[0], db[0])),
        Math.max(Math.min(da[6], db[6]), 1e-6)
    );
    const yOverlap = safeDiv(
        Math.max(0, Math.min(da[3], db[3]) - Math.max(da[1], db[1])),
        Math.max(Math.min(da[7], db[7]), 1e-6)
    );
    const diff = da.map((value, index) => value - db[index]);
    return [
        ...da, ...db, ...diff, ...diff.map(Math.abs), ...polygonDescriptor(polygon),
        dx, dy, Math.abs(dx), Math.abs(dy), xOverlap, yOverlap,
        da[4] > db[4] ? 1 : 0, da[5] < db[5] ? 1 : 0,
    ];
}

function rowsTensor(featureRows, featureCount) {
    const rows = featureRows.length ? featureRows : [new Array(featureCount).fill(0)];
    if (rows.some(row => row.length !== featureCount)) {
        throw new Error(`ReaderNet feature mismatch: expected ${featureCount}`);
    }
    const data = new Float32Array(rows.length * featureCount);
    for (let row = 0; row < rows.length; row++) {
        data.set(rows[row], row * featureCount);
    }
    return new ort.Tensor('float32', data, [rows.length, featureCount]);
}

async function runOrderingHead(head, featureRows) {
    if (!featureRows.length) return [];
    const feed = {
        panel_features: rowsTensor(head === 'panel' ? featureRows : [], PANEL_ORDER_FEATURE_COUNT),
        bubble_features: rowsTensor(head === 'bubble' ? featureRows : [], BUBBLE_ORDER_FEATURE_COUNT),
    };
    const result = await orderingSession.run(feed);
    return Array.from(result[`${head}_logits`].data, logit => 1 / (1 + Math.exp(-logit)));
}

async function rankItemsByPairwiseModel(items, head, featureBuilder) {
    if (items.length <= 1 || !orderingSession) return [...items];

    const pairs = [];
    const featureRows = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = 0; j < items.length; j++) {
            if (i === j) continue;
            pairs.push([i, j]);
            featureRows.push(featureBuilder(items[i], items[j]));
        }
    }

    const probabilities = await runOrderingHead(head, featureRows);
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
function pageShape(bitmap, bubbles, panels) {
    if (bitmap?.width && bitmap?.height) {
        return { width: bitmap.width, height: bitmap.height };
    }
    const boxes = [...(bubbles || []), ...(panels || [])];
    return {
        width: Math.max(1, ...boxes.map(boxRight)),
        height: Math.max(1, ...boxes.map(boxBottom)),
    };
}

function pointSegmentDistance(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared))
        : 0;
    return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function signedPolygonDistance(point, polygon) {
    let inside = false;
    let distance = Infinity;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const a = polygon[previous];
        const b = polygon[index];
        distance = Math.min(distance, pointSegmentDistance(point, a, b));
        if ((a[1] > point[1]) !== (b[1] > point[1])) {
            const crossingX = (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0];
            if (point[0] < crossingX) inside = !inside;
        }
    }
    return inside || distance <= 1e-9 ? distance : -distance;
}

function panelAssignmentStats(page, bubble, panel) {
    const polygon = canonicalPanelPolygon(panel, page.width, page.height);
    const center = [boxCenterX(bubble) / page.width, boxCenterY(bubble) / page.height];
    const boundaryDistance = signedPolygonDistance(center, polygon);
    const overlapArea = intersectionArea(bubble, panel);
    return {
        centerInside: boundaryDistance >= 0,
        overlapArea,
        overlapRatio: overlapArea / Math.max(1, boxArea(bubble)),
        distance: Math.abs(boundaryDistance),
        borderDistance: boundaryDistance,
        panelArea: polygonArea(polygon),
    };
}

function emptyAssignment(reason) {
    return {
        panelIndex: -1,
        panelId: null,
        reason,
        centerInside: false,
        overlapRatio: 0,
        distanceToCenter: 1,
        borderDistance: -1,
        secondBestPanelMargin: 0,
        overlapPanelCount: 0,
    };
}

function buildAssignmentInfo(panels, panelIndex, reason, statsByPanel) {
    if (panelIndex < 0 || panelIndex >= panels.length) {
        return emptyAssignment(reason);
    }

    const stats = statsByPanel[panelIndex];
    const distances = statsByPanel.map(item => item.borderDistance).sort((a, b) => b - a);
    const margin = distances.length > 1 ? distances[0] - distances[1] : Math.abs(distances[0]);
    const panel = panels[panelIndex];
    return {
        panelIndex,
        panelId: panel.panelId ?? panel.id ?? `panel_${panelIndex}`,
        reason,
        centerInside: stats.centerInside,
        overlapRatio: stats.overlapRatio,
        distanceToCenter: stats.distance,
        borderDistance: stats.borderDistance,
        secondBestPanelMargin: margin,
        overlapPanelCount: statsByPanel.filter(item => item.overlapArea > 0).length,
    };
}

function chooseAssignmentDetailed(page, bubble, panels) {
    if (!panels.length) return emptyAssignment('no_panels');

    const statsByPanel = panels.map(panel => panelAssignmentStats(page, bubble, panel));

    const containing = statsByPanel
        .map((stats, index) => ({ stats, index }))
        .filter(item => item.stats.centerInside);
    if (containing.length === 1) {
        return buildAssignmentInfo(panels, containing[0].index, 'center_inside', statsByPanel);
    }
    if (containing.length > 1) {
        containing.sort((a, b) => a.stats.panelArea - b.stats.panelArea || a.index - b.index);
        return buildAssignmentInfo(panels, containing[0].index, 'smallest_containing', statsByPanel);
    }
    let nearestIndex = 0;
    for (let index = 1; index < statsByPanel.length; index++) {
        if (statsByPanel[index].borderDistance > statsByPanel[nearestIndex].borderDistance) nearestIndex = index;
    }
    return buildAssignmentInfo(panels, nearestIndex, 'nearest_boundary', statsByPanel);
}

function assignBubblesToPanelsDetailed(bubbles, panels, bitmap) {
    const page = pageShape(bitmap, bubbles, panels);
    return bubbles.map(bubble => chooseAssignmentDetailed(page, bubble, panels));
}

// ---------------------------------------------------------------------------
// Reading-order rankers
// ---------------------------------------------------------------------------
function confidence(box) {
    const value = Number(box?.score ?? box?.conf);
    return Number.isFinite(value) ? value : 1;
}

function fullPageBox(page) {
    return { x: 0, y: 0, w: page.width, h: page.height };
}

function fallbackContexts(ordered, bitmap, assignmentByBubble = new Map()) {
    const page = pageShape(bitmap, ordered, []);
    const pageBox = fullPageBox(page);
    const contexts = new Map();
    for (let index = 0; index < ordered.length; index++) {
        const bubble = ordered[index];
        contexts.set(bubble, {
            predictedPanelIndex: -1,
            predictedPanelId: null,
            predictedPanelOrder: -1,
            predictedLocalOrder: index,
            currentPipelineIndex: index,
            panelBox: pageBox,
            assignment: assignmentByBubble.get(bubble) || emptyAssignment('mangaOrderSort'),
            bubbleConfidence: confidence(bubble),
            panelConfidence: 1,
        });
    }
    return contexts;
}

async function sortBubblesWithReadingOrderDetails(bubbles, panels, assignmentDetails, bitmap) {
    if (!orderingSession || bubbles.length < 2) {
        const boxes = mangaOrderSort(bubbles);
        return {
            boxes,
            contexts: fallbackContexts(boxes, bitmap),
            fallbackUsed: true,
        };
    }

    const { width, height } = bitmap;
    const panelGroups = new Map();
    const assignmentByBubble = new Map();
    for (let i = 0; i < bubbles.length; i++) {
        const assignment = assignmentDetails[i] || emptyAssignment('missing_assignment');
        const panelIndex = assignment.panelIndex < 0 ? 0 : assignment.panelIndex;
        assignmentByBubble.set(bubbles[i], assignment);
        if (!panelGroups.has(panelIndex)) panelGroups.set(panelIndex, []);
        panelGroups.get(panelIndex).push(bubbles[i]);
    }

    const pairRecords = [];
    const featureRows = [];
    const scoresByPanel = new Map();
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
        const group = panelGroups.get(panelIndex) || [];
        scoresByPanel.set(panelIndex, new Float32Array(group.length));
        if (group.length <= 1) continue;
        const panel = panels[panelIndex];
        for (let i = 0; i < group.length; i++) {
            for (let j = 0; j < group.length; j++) {
                if (i === j) continue;
                pairRecords.push({ panelIndex, itemIndex: i });
                featureRows.push(bubblePairFeatures(group[i], group[j], width, height, panel));
            }
        }
    }

    const probabilities = await runOrderingHead('bubble', featureRows);
    for (let index = 0; index < pairRecords.length; index++) {
        const record = pairRecords[index];
        scoresByPanel.get(record.panelIndex)[record.itemIndex] += probabilities[index];
    }

    const sorted = [];
    const contexts = new Map();
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
        const group = panelGroups.get(panelIndex) || [];
        if (!group.length) continue;
        const panel = panels[panelIndex];
        const scores = scoresByPanel.get(panelIndex);
        const orderedGroup = Array.from({ length: group.length }, (_, index) => index)
            .sort((a, b) => scores[b] - scores[a] || a - b)
            .map(index => group[index]);
        const panelId = panel.panelId ?? panel.id ?? `panel_${panelIndex}`;
        for (let localIndex = 0; localIndex < orderedGroup.length; localIndex++) {
            const bubble = orderedGroup[localIndex];
            contexts.set(bubble, {
                predictedPanelIndex: panelIndex,
                predictedPanelId: panelId,
                predictedPanelOrder: panelIndex,
                predictedLocalOrder: localIndex,
                currentPipelineIndex: sorted.length + localIndex,
                panelBox: panel,
                assignment: assignmentByBubble.get(bubble) || emptyAssignment('missing_assignment'),
                bubbleConfidence: confidence(bubble),
                panelConfidence: confidence(panel),
            });
        }
        sorted.push(...orderedGroup);
    }

    if (sorted.length !== bubbles.length) {
        const boxes = mangaOrderSort(bubbles);
        return {
            boxes,
            contexts: fallbackContexts(boxes, bitmap, assignmentByBubble),
            fallbackUsed: true,
        };
    }

    return { boxes: sorted, contexts, fallbackUsed: false };
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
