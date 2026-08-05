import * as ort from 'onnxruntime-web';
import modelRegistry from '@poneglyph/shared/model-registry.json';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;

// ---------------------------------------------------------------------------
// Model URLs
// ---------------------------------------------------------------------------
const ONE_SHOT_ARTIFACT = modelRegistry.models['one-shot-reading-order'].artifact;
const ONE_SHOT_MODEL_REVISION = ONE_SHOT_ARTIFACT.revision;
const ONE_SHOT_MODEL_BASE = `https://huggingface.co/${ONE_SHOT_ARTIFACT.repository}/resolve/${ONE_SHOT_MODEL_REVISION}`;
const BUBBLE_MODEL_PATH = `${ONE_SHOT_MODEL_BASE}/bubble_detector.onnx`;
const PANEL_MODEL_PATH = `${ONE_SHOT_MODEL_BASE}/panel_detector.onnx`;
const PANEL_ORDER_PATH = `${ONE_SHOT_MODEL_BASE}/panel_order.onnx`;
const BUBBLE_ORDER_PATH = `${ONE_SHOT_MODEL_BASE}/bubble_order.onnx`;
const GLOBAL_BUBBLE_ORDER_PATH = `${ONE_SHOT_MODEL_BASE}/global_bubble_order.onnx`;
const GLOBAL_BUBBLE_ORDER_FEATURES_PATH = `${ONE_SHOT_MODEL_BASE}/global_bubble_order_features.json`;

const BUBBLE_SCORE_THRESHOLD = 0.45;
const BUBBLE_DUPLICATE_IOU_THRESHOLD = 0.9;
const VERTICAL_REPAIR_GAP_FACTOR = 1.5;
const VERTICAL_REPAIR_MAX_Y_OVERLAP = 0.05;
const VERTICAL_REPAIR_MAX_AREA_RATIO = 0.7;

let bubbleSession = null;
let panelSession = null;
let panelOrderSession = null;
let bubbleOrderSession = null;
let globalBubbleOrderSession = null;
let globalBubbleOrderFeatureCount = null;
let globalBubbleOrderPostprocess = null;
let globalBubbleOrderLoadAttempted = false;
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

async function fetchOptionalJson(url) {
    const response = await fetch(url);
    if (!response.ok) return null;
    return response.json();
}

function numberOrDefault(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeGlobalBubbleOrderPostprocess(postprocess) {
    if (postprocess?.name !== 'vertical_small_bubble_repair_v1') {
        return null;
    }
    return {
        name: postprocess.name,
        gapFactor: numberOrDefault(postprocess.gap_factor, VERTICAL_REPAIR_GAP_FACTOR),
        maxYOverlap: numberOrDefault(postprocess.max_y_overlap, VERTICAL_REPAIR_MAX_Y_OVERLAP),
        maxAreaRatio: numberOrDefault(postprocess.max_area_ratio, VERTICAL_REPAIR_MAX_AREA_RATIO)
    };
}

function sessionFeatureCount(session) {
    try {
        const inputName = session.inputNames?.[0];
        const dims = session.inputMetadata?.[inputName]?.dims;
        const featureCount = Number(dims?.[1]);
        return Number.isFinite(featureCount) && featureCount > 0 ? featureCount : null;
    } catch {
        return null;
    }
}

async function loadOptionalGlobalBubbleOrder() {
    globalBubbleOrderLoadAttempted = true;
    globalBubbleOrderPostprocess = null;
    try {
        const featureSchema = await fetchOptionalJson(GLOBAL_BUBBLE_ORDER_FEATURES_PATH);
        const featureCount = Number(featureSchema?.feature_count);
        if (!Number.isFinite(featureCount) || featureCount <= 0) {
            console.warn("[Worker] Global bubble reranker disabled: feature schema missing");
            return;
        }

        const buffer = await fetchModel(GLOBAL_BUBBLE_ORDER_PATH);
        const session = await ort.InferenceSession.create(buffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
        });
        const onnxFeatureCount = sessionFeatureCount(session);
        if (onnxFeatureCount !== null && onnxFeatureCount !== featureCount) {
            console.warn(
                "[Worker] Global bubble reranker disabled: feature count mismatch",
                { featureCount, onnxFeatureCount }
            );
            await session.release?.();
            return;
        }

        globalBubbleOrderSession = session;
        globalBubbleOrderFeatureCount = featureCount;
        globalBubbleOrderPostprocess = normalizeGlobalBubbleOrderPostprocess(
            featureSchema?.postprocess
        );
        console.log(
            `[Worker] Global bubble reranker loaded (${featureCount} features)`,
            { postprocess: globalBubbleOrderPostprocess?.name ?? null }
        );
    } catch (err) {
        globalBubbleOrderSession = null;
        globalBubbleOrderFeatureCount = null;
        globalBubbleOrderPostprocess = null;
        console.warn("[Worker] Global bubble reranker unavailable; using current pipeline", err);
    }
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
                panelOrderSession &&
                bubbleOrderSession &&
                globalBubbleOrderLoadAttempted
            ) {
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

            await loadOptionalGlobalBubbleOrder();

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

            if (panels.length > 0 && panelOrderSession && bubbleOrderSession) {
                // 3. Sort panels by reading order
                sortedPanels = await rankPanels(panels, bitmap);

                // 4. Assign bubbles to panels
                assignmentDetails = assignBubblesToPanelsDetailed(boxes, sortedPanels, bitmap);

                // 5. Sort bubbles within each panel using the current reading-order ranker
                currentOrder = await sortBubblesWithReadingOrderDetails(
                    boxes,
                    sortedPanels,
                    assignmentDetails,
                    bitmap
                );
                sortedBoxes = currentOrder.boxes;

                if (globalBubbleOrderSession) {
                    try {
                        const globalBoxes = await applyPanelConstrainedGlobalBubbleReranker(
                            currentOrder.boxes,
                            sortedPanels,
                            currentOrder.contexts,
                            bitmap
                        );
                        if (globalBoxes.length === boxes.length) {
                            sortedBoxes = applyGlobalBubblePostprocess(
                                globalBoxes,
                                currentOrder.contexts
                            );
                            console.log("[Worker] Reading order mode: global_reranker_panel_constrained");
                            readingOrderMode = 'global_reranker_panel_constrained';
                        } else {
                            console.warn("[Worker] Global reranker returned incomplete order");
                            console.log("[Worker] Reading order mode: current_pipeline");
                            readingOrderMode = 'current_pipeline';
                        }
                    } catch (err) {
                        console.warn("[Worker] Global reranker failed; using current pipeline", err);
                        console.log("[Worker] Reading order mode: current_pipeline");
                        readingOrderMode = 'current_pipeline';
                    }
                } else {
                    console.log("[Worker] Reading order mode: current_pipeline");
                    readingOrderMode = 'current_pipeline';
                }
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
        modelRevision: ONE_SHOT_MODEL_REVISION,
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

    let inH = 800, inW = 800;
    try {
        const inName = panelSession.inputNames?.[0];
        const meta = panelSession.inputMetadata?.[inName];
        if (meta?.dims && meta.dims.length >= 4) {
            inH = meta.dims[2];
            inW = meta.dims[3];
        }
    } catch {
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
            conf: p.conf
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

function finite(value) {
    return Number.isFinite(value) ? Math.max(-20, Math.min(20, value)) : 0;
}

function finiteFeatures(values) {
    return values.map(finite);
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

function intersectionArea(a, b) {
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(boxRight(a), boxRight(b));
    const iy2 = Math.min(boxBottom(a), boxBottom(b));
    return Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
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

function containsCenter(panel, bubble) {
    const cx = boxCenterX(bubble);
    const cy = boxCenterY(bubble);
    return panel.x <= cx && cx <= boxRight(panel) && panel.y <= cy && cy <= boxBottom(panel);
}

function borderDistance(panel, bubble) {
    const cx = boxCenterX(bubble);
    const cy = boxCenterY(bubble);
    const divisor = Math.max(1, Math.max(panel.w, panel.h));
    if (!containsCenter(panel, bubble)) {
        const dx = Math.max(panel.x - cx, 0, cx - boxRight(panel));
        const dy = Math.max(panel.y - cy, 0, cy - boxBottom(panel));
        return -Math.hypot(dx, dy) / divisor;
    }
    return Math.min(
        cx - panel.x,
        boxRight(panel) - cx,
        cy - panel.y,
        boxBottom(panel) - cy
    ) / divisor;
}

function panelDistance(page, panel, bubble) {
    return Math.hypot(
        boxCenterX(bubble) - boxCenterX(panel),
        boxCenterY(bubble) - boxCenterY(panel)
    ) / Math.max(1, Math.hypot(page.width, page.height));
}

function panelAssignmentStats(page, bubble, panel) {
    const overlapArea = intersectionArea(bubble, panel);
    return {
        centerInside: containsCenter(panel, bubble),
        overlapArea,
        overlapRatio: overlapArea / Math.max(1, boxArea(bubble)),
        distance: panelDistance(page, panel, bubble),
        borderDistance: borderDistance(panel, bubble),
        panelArea: boxArea(panel),
    };
}

function assignmentScore(stats) {
    return (stats.centerInside ? 2 : 0) + stats.overlapRatio - Math.min(1, stats.distance);
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
    const scores = statsByPanel
        .map(assignmentScore)
        .sort((a, b) => b - a);
    const margin = scores.length > 1 ? scores[0] - scores[1] : scores[0];
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

    for (let index = 0; index < statsByPanel.length; index++) {
        if (statsByPanel[index].centerInside) {
            return buildAssignmentInfo(panels, index, 'first_center_panel', statsByPanel);
        }
    }

    let bestOverlapArea = -1;
    let bestOverlapIndex = -1;
    for (let index = 0; index < statsByPanel.length; index++) {
        const overlapArea = statsByPanel[index].overlapArea;
        if (overlapArea > 0 && overlapArea > bestOverlapArea) {
            bestOverlapArea = overlapArea;
            bestOverlapIndex = index;
        }
    }
    if (bestOverlapIndex >= 0) {
        return buildAssignmentInfo(panels, bestOverlapIndex, 'largest_overlap_area', statsByPanel);
    }

    let bestDistance = Infinity;
    let bestDistanceIndex = -1;
    for (let index = 0; index < statsByPanel.length; index++) {
        const distance = statsByPanel[index].distance;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestDistanceIndex = index;
        }
    }
    return buildAssignmentInfo(panels, bestDistanceIndex, 'nearest_panel_center', statsByPanel);
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

function relativeBox(box, panel) {
    return {
        x: box.x - panel.x,
        y: box.y - panel.y,
        w: box.w,
        h: box.h,
    };
}

function normalizedOrder(index, total) {
    return safeDiv(index, Math.max(1, total - 1));
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
    if (!bubbleOrderSession || bubbles.length < 2) {
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

    const sorted = [];
    const contexts = new Map();
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
        const group = panelGroups.get(panelIndex) || [];
        if (!group.length) continue;
        const panel = panels[panelIndex];
        const orderedGroup = group.length <= 1
            ? [...group]
            : await rankItemsByPairwiseModel(
                group,
                bubbleOrderSession,
                (a, b) => bubblePairFeatures(a, b, width, height, panel)
            );
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

function assignmentFeatures(info, panelCount) {
    return [
        info.centerInside ? 1 : 0,
        info.overlapRatio,
        info.distanceToCenter,
        info.borderDistance,
        info.secondBestPanelMargin,
        safeDiv(info.overlapPanelCount, Math.max(1, panelCount)),
    ];
}

function defaultBubbleContext(page, bubbles, bubble, contexts) {
    const index = Math.max(0, bubbles.indexOf(bubble));
    const pageBox = fullPageBox(page);
    return contexts.get(bubble) || {
        predictedPanelIndex: -1,
        predictedPanelId: null,
        predictedPanelOrder: -1,
        predictedLocalOrder: index,
        currentPipelineIndex: index,
        panelBox: pageBox,
        assignment: emptyAssignment('missing_context'),
        bubbleConfidence: confidence(bubble),
        panelConfidence: 1,
    };
}

function globalBubblePairFeatures(page, bubbles, a, b, contexts, panelCount) {
    const aContext = defaultBubbleContext(page, bubbles, a, contexts);
    const bContext = defaultBubbleContext(page, bubbles, b, contexts);
    const bubbleCount = Math.max(1, bubbles.length);
    const normalizedPanelCount = Math.max(1, panelCount);
    const panelOrderA = normalizedOrder(Math.max(0, aContext.predictedPanelOrder), normalizedPanelCount);
    const panelOrderB = normalizedOrder(Math.max(0, bContext.predictedPanelOrder), normalizedPanelCount);
    const localOrderA = normalizedOrder(Math.max(0, aContext.predictedLocalOrder), bubbleCount);
    const localOrderB = normalizedOrder(Math.max(0, bContext.predictedLocalOrder), bubbleCount);
    const currentIndexA = normalizedOrder(Math.max(0, aContext.currentPipelineIndex), bubbleCount);
    const currentIndexB = normalizedOrder(Math.max(0, bContext.currentPipelineIndex), bubbleCount);
    const relativeA = relativeBox(a, aContext.panelBox);
    const relativeB = relativeBox(b, bContext.panelBox);

    return finiteFeatures([
        ...pairFeatures(a, b, page.width, page.height),
        aContext.predictedPanelId === bContext.predictedPanelId ? 1 : 0,
        panelOrderA,
        panelOrderB,
        panelOrderA - panelOrderB,
        localOrderA,
        localOrderB,
        localOrderA - localOrderB,
        currentIndexA,
        currentIndexB,
        currentIndexA - currentIndexB,
        ...boxFeatures(relativeA, Math.max(1, aContext.panelBox.w), Math.max(1, aContext.panelBox.h)),
        ...boxFeatures(relativeB, Math.max(1, bContext.panelBox.w), Math.max(1, bContext.panelBox.h)),
        ...boxFeatures(aContext.panelBox, page.width, page.height),
        ...boxFeatures(bContext.panelBox, page.width, page.height),
        aContext.bubbleConfidence,
        bContext.bubbleConfidence,
        aContext.panelConfidence,
        bContext.panelConfidence,
        ...assignmentFeatures(aContext.assignment, normalizedPanelCount),
        ...assignmentFeatures(bContext.assignment, normalizedPanelCount),
    ]);
}

async function applyGlobalBubbleReranker(bubbles, panels, contexts, bitmap, featureBubbles = bubbles) {
    if (!globalBubbleOrderSession || !globalBubbleOrderFeatureCount || bubbles.length <= 1) {
        return [...bubbles];
    }

    const page = pageShape(bitmap, featureBubbles, panels);
    const pairs = [];
    const featureRows = [];
    for (let i = 0; i < bubbles.length; i++) {
        for (let j = 0; j < bubbles.length; j++) {
            if (i === j) continue;
            const features = globalBubblePairFeatures(
                page,
                featureBubbles,
                bubbles[i],
                bubbles[j],
                contexts,
                panels.length
            );
            if (features.length !== globalBubbleOrderFeatureCount) {
                throw new Error(
                    `Global reranker feature mismatch: got ${features.length}, expected ${globalBubbleOrderFeatureCount}`
                );
            }
            pairs.push([i, j]);
            featureRows.push(features);
        }
    }

    const probabilities = await runPairwiseModel(globalBubbleOrderSession, featureRows);
    const scores = new Float32Array(bubbles.length).fill(0);
    for (let index = 0; index < pairs.length; index++) {
        const [i] = pairs[index];
        scores[i] += probabilities[index];
    }

    return Array.from({ length: bubbles.length }, (_, index) => index)
        .sort((a, b) => scores[b] - scores[a] || a - b)
        .map(index => bubbles[index]);
}

async function applyPanelConstrainedGlobalBubbleReranker(currentBoxes, panels, contexts, bitmap) {
    if (!globalBubbleOrderSession || currentBoxes.length <= 1) {
        return [...currentBoxes];
    }

    const groups = Array.from({ length: panels.length }, () => []);
    const unassigned = [];
    for (const box of currentBoxes) {
        const context = contexts.get(box);
        const panelIndex = Number(context?.predictedPanelIndex);
        if (
            Number.isInteger(panelIndex) &&
            panelIndex >= 0 &&
            panelIndex < panels.length
        ) {
            groups[panelIndex].push(box);
        } else {
            unassigned.push(box);
        }
    }

    const ordered = [];
    for (const group of groups) {
        if (!group.length) continue;
        let orderedGroup = group;
        if (group.length > 1) {
            orderedGroup = await applyGlobalBubbleReranker(
                group,
                panels,
                contexts,
                bitmap,
                currentBoxes
            );
        }
        if (orderedGroup.length !== group.length) {
            orderedGroup = group;
        }
        ordered.push(...applyGlobalBubblePostprocess(orderedGroup, contexts));
    }
    ordered.push(...unassigned);

    return ordered.length === currentBoxes.length ? ordered : [...currentBoxes];
}

function applyGlobalBubblePostprocess(boxes, contexts) {
    if (globalBubbleOrderPostprocess?.name === 'vertical_small_bubble_repair_v1') {
        return applyVerticalSmallBubbleRepair(boxes, contexts, globalBubbleOrderPostprocess);
    }
    return boxes;
}

function shouldApplyVerticalSmallBubbleRepair(
    lowerCandidate,
    upperCandidate,
    contexts,
    config
) {
    const lowerContext = contexts.get(lowerCandidate);
    const upperContext = contexts.get(upperCandidate);
    if (!lowerContext || !upperContext) return false;
    if (lowerContext.predictedPanelId !== upperContext.predictedPanelId) return false;

    const gapFactor = config?.gapFactor ?? VERTICAL_REPAIR_GAP_FACTOR;
    const maxYOverlap = config?.maxYOverlap ?? VERTICAL_REPAIR_MAX_Y_OVERLAP;
    const maxAreaRatio = config?.maxAreaRatio ?? VERTICAL_REPAIR_MAX_AREA_RATIO;

    const verticalGap = boxCenterY(lowerCandidate) - boxCenterY(upperCandidate);
    if (
        verticalGap < Math.max(lowerCandidate.h, upperCandidate.h) * gapFactor
    ) {
        return false;
    }

    const overlapY = safeDiv(
        intervalOverlap(
            lowerCandidate.y,
            boxBottom(lowerCandidate),
            upperCandidate.y,
            boxBottom(upperCandidate)
        ),
        Math.min(lowerCandidate.h, upperCandidate.h)
    );
    if (overlapY > maxYOverlap) return false;

    const areaRatio = safeDiv(
        boxArea(lowerCandidate),
        Math.max(1, boxArea(upperCandidate))
    );
    return areaRatio <= maxAreaRatio;
}

function applyVerticalSmallBubbleRepair(boxes, contexts, config) {
    const repaired = [...boxes];
    for (let index = 0; index < repaired.length - 1; index++) {
        if (
            shouldApplyVerticalSmallBubbleRepair(
                repaired[index],
                repaired[index + 1],
                contexts,
                config
            )
        ) {
            [repaired[index], repaired[index + 1]] = [repaired[index + 1], repaired[index]];
        }
    }
    return repaired;
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
