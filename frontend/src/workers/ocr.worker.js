import * as ort from 'onnxruntime-web';
import { capitalizeOcrSentenceStarts, fixFrenchPunctuation } from '../lib/ocr-utils.js';
import modelRegistry from '@poneglyph/shared/model-registry.json';

ort.env.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;
ort.env.wasm.proxy = false;
ort.env.wasm.simd = true;
ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(16, Math.max(1, self.navigator?.hardwareConcurrency || 1))
    : 1;
if (ort.env.webgpu) {
    ort.env.webgpu.powerPreference = 'high-performance';
}

let currentModelId = null;
let ppocrLineDetectorSession = null;
let ppocrRecSession = null;
let ppocrManifest = null;
let ppocrRuntimeProvider = null;
let ppocrWarmupDone = false;
let ppocrLineDetectorBuffer = null;
let ppocrRecBuffer = null;
let ppocrRunQueue = Promise.resolve();

const PPOCR_MODEL_ARTIFACT = modelRegistry.models['ppocrv6-line'].artifact;
const PPOCR_LINE_MODEL_BASE = `https://huggingface.co/${PPOCR_MODEL_ARTIFACT.repository}/resolve/${PPOCR_MODEL_ARTIFACT.revision}/onnx`;
const PPOCR_LINE_DETECTOR_PATH = `${PPOCR_LINE_MODEL_BASE}/bubble_line_detector_yolo26n.onnx`;
const PPOCR_REC_PATH = `${PPOCR_LINE_MODEL_BASE}/ppocrv6_bubble_line_rec.onnx`;
const PPOCR_REC_WEBGPU_COMPAT_PATH = `${PPOCR_LINE_MODEL_BASE}/ppocrv6_bubble_line_rec_webgpu.onnx`;
const PPOCR_MANIFEST_PATH = `${PPOCR_LINE_MODEL_BASE}/browser_manifest.json`;
const PPOCR_LINE_CONF = 0.25;
const PPOCR_LINE_NMS_IOU = 0.75;
const PPOCR_LINE_PAD = 2;
const PPOCR_LINE_GAP = 8;
const PPOCR_LINE_FALLBACK_INPUT_SIZE = 1024;
const PPOCR_SESSION_PROVIDER_CANDIDATES = self.navigator?.gpu
    ? [['webgpu', 'wasm'], ['wasm']]
    : [['wasm']];

const MODELS = {
    ppocrv6Line: {
        id: `${PPOCR_MODEL_ARTIFACT.repository}@${PPOCR_MODEL_ARTIFACT.revision}#webgpu-compat`,
        runtime: 'onnx',
        paths: {
            detector: PPOCR_LINE_DETECTOR_PATH,
            rec: PPOCR_REC_WEBGPU_COMPAT_PATH,
            manifest: PPOCR_MANIFEST_PATH,
        },
    },
    ppocrv6LineOriginal: {
        id: `${PPOCR_MODEL_ARTIFACT.repository}@${PPOCR_MODEL_ARTIFACT.revision}`,
        runtime: 'onnx',
        paths: {
            detector: PPOCR_LINE_DETECTOR_PATH,
            rec: PPOCR_REC_PATH,
            manifest: PPOCR_MANIFEST_PATH,
        },
    },
};

async function fetchArrayBufferWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telechargement impossible: ${url}`);

    const total = Number(response.headers.get('content-length') || 0);
    if (!response.body) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (total && onProgress) onProgress(loaded, total);
    }

    const buffer = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return buffer;
}

function roundMs(value) {
    return Math.round(value * 10) / 10;
}

async function createOrtSession(buffer, name, providerCandidates = PPOCR_SESSION_PROVIDER_CANDIDATES) {
    let lastError = null;
    for (const executionProviders of providerCandidates) {
        try {
            const session = await ort.InferenceSession.create(buffer, {
                executionProviders,
                graphOptimizationLevel: 'all',
                executionMode: 'sequential',
                enableCpuMemArena: true,
                enableMemPattern: true,
            });
            return { session, provider: executionProviders[0] };
        } catch (err) {
            lastError = err;
            if (executionProviders[0] !== 'wasm') {
                console.warn(`[Worker] ${name} indisponible en ${executionProviders[0]}, fallback WASM`, err);
            }
        }
    }
    throw lastError || new Error(`Session ONNX impossible: ${name}`);
}

async function forcePpocrWasmSessions(reason) {
    if (!ppocrLineDetectorBuffer || !ppocrRecBuffer) {
        throw reason || new Error("Buffers PP-OCRv6 indisponibles pour fallback WASM.");
    }
    console.warn("[Worker] Fallback PP-OCRv6 vers WASM", reason);
    await ppocrLineDetectorSession?.release?.();
    await ppocrRecSession?.release?.();
    ppocrWarmupDone = false;

    const detectorSession = await createOrtSession(ppocrLineDetectorBuffer, 'YOLO lignes', [['wasm']]);
    const recSession = await createOrtSession(ppocrRecBuffer, 'PP-OCRv6 recognition', [['wasm']]);
    ppocrLineDetectorSession = detectorSession.session;
    ppocrRecSession = recSession.session;
    ppocrRuntimeProvider = 'wasm';
    await warmupPpocrLinePipeline();
}

async function loadPpocrLinePipeline(progressCallback, modelConfig = MODELS.ppocrv6Line) {
    if (ppocrLineDetectorSession && ppocrRecSession && ppocrManifest && currentModelId === modelConfig.id) return;

    await ppocrLineDetectorSession?.release?.();
    await ppocrRecSession?.release?.();
    ppocrLineDetectorSession = null;
    ppocrRecSession = null;
    ppocrManifest = null;
    ppocrRuntimeProvider = null;
    ppocrWarmupDone = false;
    ppocrLineDetectorBuffer = null;
    ppocrRecBuffer = null;

    const paths = modelConfig.paths || MODELS.ppocrv6Line.paths;
    const manifestResponse = await fetch(paths.manifest);
    if (!manifestResponse.ok) throw new Error("Manifest PP-OCRv6 introuvable.");
    ppocrManifest = await manifestResponse.json();

    const files = [
        { url: paths.detector, name: 'YOLO lignes' },
        { url: paths.rec, name: 'PP-OCRv6 recognition' },
    ];

    const sizes = await Promise.all(files.map(async (file) => {
        try {
            const response = await fetch(file.url, { method: 'HEAD' });
            return Number(response.headers.get('content-length') || 0);
        } catch {
            return 0;
        }
    }));
    const totalSize = sizes.reduce((sum, size) => sum + size, 0) || 90_000_000;
    let loadedBefore = 0;

    const detectorBuffer = await fetchArrayBufferWithProgress(files[0].url, (loaded) => {
        progressCallback({ file: files[0].name, progress: ((loadedBefore + loaded) / totalSize) * 100 });
    });
    ppocrLineDetectorBuffer = detectorBuffer;
    const detectorSession = await createOrtSession(detectorBuffer, files[0].name);
    ppocrLineDetectorSession = detectorSession.session;
    loadedBefore += detectorBuffer.byteLength;

    const recBuffer = await fetchArrayBufferWithProgress(files[1].url, (loaded) => {
        progressCallback({ file: files[1].name, progress: ((loadedBefore + loaded) / totalSize) * 100 });
    });
    ppocrRecBuffer = recBuffer;
    const recSession = await createOrtSession(recBuffer, files[1].name);
    ppocrRecSession = recSession.session;
    ppocrRuntimeProvider = detectorSession.provider === recSession.provider
        ? recSession.provider
        : `${detectorSession.provider}+${recSession.provider}`;
    try {
        await warmupPpocrLinePipeline();
    } catch (err) {
        if ((ppocrRuntimeProvider || '').includes('webgpu')) {
            await forcePpocrWasmSessions(err);
        } else {
            console.warn("[Worker] Warmup PP-OCRv6 ignoré", err);
        }
    }
}

function detectorInputSize(session) {
    try {
        const inputName = session.inputNames?.[0];
        const metadata = session.inputMetadata;
        const inputMeta = metadata?.get?.(inputName)
            || metadata?.[inputName]
            || session.inputMetadata?.[0]
            || session.inputMetadata?.get?.(0);
        const dims = inputMeta?.dims || inputMeta?.dimensions || inputMeta?.shape;
        const height = Number(dims?.[2]);
        const width = Number(dims?.[3]);
        if (height > 0 && width > 0) return { height, width };
    } catch (err) {
        console.warn("[Worker] Taille YOLO lignes illisible, fallback 1024", err);
    }
    return { height: PPOCR_LINE_FALLBACK_INPUT_SIZE, width: PPOCR_LINE_FALLBACK_INPUT_SIZE };
}

function preprocessYoloBitmap(bitmap, targetH, targetW) {
    const scale = Math.min(targetW / bitmap.width, targetH / bitmap.height);
    const newW = Math.round(bitmap.width * scale);
    const newH = Math.round(bitmap.height * scale);
    const padX = (targetW - newW) / 2;
    const padY = (targetH - newH) / 2;

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(bitmap, padX, padY, newW, newH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH).data;
    const pixelCount = targetW * targetH;
    const data = new Float32Array(3 * pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        data[i] = imageData[i * 4] / 255;
        data[pixelCount + i] = imageData[i * 4 + 1] / 255;
        data[2 * pixelCount + i] = imageData[i * 4 + 2] / 255;
    }
    return {
        inputTensor: new ort.Tensor('float32', data, [1, 3, targetH, targetW]),
        scale,
        padX,
        padY,
    };
}

function area(box) {
    return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function boxIou(left, right) {
    const ix1 = Math.max(left.x1, right.x1);
    const iy1 = Math.max(left.y1, right.y1);
    const ix2 = Math.min(left.x2, right.x2);
    const iy2 = Math.min(left.y2, right.y2);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    return inter / Math.max(area(left) + area(right) - inter, 1e-6);
}

function dedupeBoxes(boxes, threshold) {
    const kept = [];
    for (const box of [...boxes].sort((a, b) => b.conf - a.conf)) {
        if (kept.every(existing => boxIou(box, existing) < threshold)) kept.push(box);
    }
    return kept;
}

function sortLineBoxes(boxes) {
    if (!boxes.length) return [];
    const heights = boxes.map(box => box.y2 - box.y1).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)];
    const band = Math.max(10, medianH * 0.65);
    return [...boxes].sort((a, b) => {
        const aBand = Math.round(((a.y1 + a.y2) / 2) / band);
        const bBand = Math.round(((b.y1 + b.y2) / 2) / band);
        return aBand - bBand || a.x1 - b.x1;
    });
}

function postprocessLineDetections(output, scale, padX, padY, imageW, imageH) {
    const boxes = [];
    for (let i = 0; i < output.length; i += 6) {
        const score = output[i + 4];
        if (score < PPOCR_LINE_CONF) continue;

        const x1 = Math.max(0, Math.min((output[i] - padX) / scale, imageW));
        const y1 = Math.max(0, Math.min((output[i + 1] - padY) / scale, imageH));
        const x2 = Math.max(0, Math.min((output[i + 2] - padX) / scale, imageW));
        const y2 = Math.max(0, Math.min((output[i + 3] - padY) / scale, imageH));
        const box = { x1, y1, x2, y2, conf: score };
        if ((x2 - x1) >= 4 && (y2 - y1) >= 4 && area(box) >= 24) boxes.push(box);
    }
    return sortLineBoxes(dedupeBoxes(boxes, PPOCR_LINE_NMS_IOU));
}

async function detectLineBoxes(bitmap) {
    const { height, width } = detectorInputSize(ppocrLineDetectorSession);
    const { inputTensor, scale, padX, padY } = preprocessYoloBitmap(bitmap, height, width);
    const result = await ppocrLineDetectorSession.run({
        [ppocrLineDetectorSession.inputNames[0]]: inputTensor,
    });
    const output = result[ppocrLineDetectorSession.outputNames[0]].data;
    return postprocessLineDetections(output, scale, padX, padY, bitmap.width, bitmap.height);
}

function stitchLineBoxes(bitmap, boxes) {
    const usableBoxes = boxes.length ? boxes : [{ x1: 0, y1: 0, x2: bitmap.width, y2: bitmap.height, conf: 1 }];
    const crops = usableBoxes.map((box) => {
        const x1 = Math.max(0, Math.floor(box.x1) - PPOCR_LINE_PAD);
        const y1 = Math.max(0, Math.floor(box.y1) - PPOCR_LINE_PAD);
        const x2 = Math.min(bitmap.width, Math.ceil(box.x2) + PPOCR_LINE_PAD);
        const y2 = Math.min(bitmap.height, Math.ceil(box.y2) + PPOCR_LINE_PAD);
        return { x1, y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
    }).filter(crop => crop.w > 0 && crop.h > 0);

    const targetH = Math.max(...crops.map(crop => crop.h));
    const resized = crops.map((crop) => {
        const w = crop.h === targetH ? crop.w : Math.max(1, Math.round(crop.w * (targetH / crop.h)));
        return { ...crop, targetW: w, targetH };
    });
    const totalW = resized.reduce((sum, crop) => sum + crop.targetW, 0) + PPOCR_LINE_GAP * Math.max(0, resized.length - 1);

    const canvas = new OffscreenCanvas(Math.max(1, totalW), targetH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let x = 0;
    for (const crop of resized) {
        ctx.drawImage(bitmap, crop.x1, crop.y1, crop.w, crop.h, x, 0, crop.targetW, crop.targetH);
        x += crop.targetW + PPOCR_LINE_GAP;
    }
    return canvas;
}

function preprocessPpocrCanvas(canvas) {
    const height = ppocrManifest.image_height || 48;
    const minWidth = ppocrManifest.min_image_width || 960;
    const maxWidth = ppocrManifest.max_image_width || 3200;
    const aspectWidth = Math.ceil(height * (canvas.width / Math.max(1, canvas.height)));
    const width = Math.min(maxWidth, Math.max(minWidth, aspectWidth));

    const resized = new OffscreenCanvas(width, height);
    const ctx = resized.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, width, height);

    const rgba = ctx.getImageData(0, 0, width, height).data;
    const pixelCount = width * height;
    const data = new Float32Array(3 * pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        data[i] = (b / 255 - 0.5) / 0.5;
        data[pixelCount + i] = (g / 255 - 0.5) / 0.5;
        data[2 * pixelCount + i] = (r / 255 - 0.5) / 0.5;
    }
    return new ort.Tensor('float32', data, [1, 3, height, width]);
}

function decodePpocrCtc(output) {
    const chars = ppocrManifest.character_list || [];
    const blankId = ppocrManifest.blank_token_id || 0;
    const vocabSize = chars.length;
    const sequenceLength = Math.floor(output.length / vocabSize);
    const decoded = [];
    let previous = null;

    for (let step = 0; step < sequenceLength; step++) {
        let bestIndex = 0;
        let bestValue = -Infinity;
        const offset = step * vocabSize;
        for (let i = 0; i < vocabSize; i++) {
            const value = output[offset + i];
            if (value > bestValue) {
                bestValue = value;
                bestIndex = i;
            }
        }
        if (bestIndex !== blankId && bestIndex !== previous && bestIndex < chars.length) {
            decoded.push(chars[bestIndex]);
        }
        previous = bestIndex;
    }
    return decoded.join('');
}

const PPOCR_TOKEN_RE = /[\p{L}]+(?:['\u2019][\p{L}]+)?/gu;
const PPOCR_LETTER_RE = /\p{L}/u;

function normalizePpocrPostprocessSpacing(text) {
    return String(text || '')
        .trim()
        .replace(/\u2026/g, '...')
        .replace(/\s+/g, ' ')
        .replace(/\s*\.\s*\.\s*\./g, '<ELLIPSIS>')
        .replace(/\s+([,.])/g, '$1')
        .replace(/([,.])(\S)/g, '$1 $2')
        .replace(/\s*([!?;:]+)/g, ' $1')
        .replace(/<ELLIPSIS>/g, '...')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPpocrWeirdCase(token) {
    const letters = [...token].filter(char => PPOCR_LETTER_RE.test(char));
    if (letters.length < 2) return false;
    const hasUpper = letters.some(char => char === char.toLocaleUpperCase('fr-FR') && char !== char.toLocaleLowerCase('fr-FR'));
    const hasLower = letters.some(char => char === char.toLocaleLowerCase('fr-FR') && char !== char.toLocaleUpperCase('fr-FR'));
    if (!hasUpper || !hasLower) return false;
    const titleLike = token[0] === token[0].toLocaleUpperCase('fr-FR')
        && token.slice(1) === token.slice(1).toLocaleLowerCase('fr-FR');
    return !titleLike;
}

function postprocessPpocrText(text) {
    const rules = ppocrManifest?.postprocess;
    if (!rules?.enabled || !rules.lexicon) return capitalizeOcrSentenceStarts(text);

    const lexicon = rules.lexicon || {};
    const minCount = Number(rules.min_count || 1);
    const minRatio = Number(rules.min_ratio || 1);
    const maxLowerRatio = Number(rules.max_lower_ratio || 0);
    const sentenceStart = Boolean(rules.sentence_start);
    const spaced = normalizePpocrPostprocessSpacing(text);

    const lexiconCorrected = spaced.replace(PPOCR_TOKEN_RE, (token, offset) => {
        const key = token.toLocaleLowerCase('fr-FR');
        const entry = lexicon[key];
        if (!entry?.best) return token;
        if (isPpocrWeirdCase(token)) return entry.best;

        const total = Number(entry.total || 0);
        const bestRatio = Number(entry.best_ratio || 0);
        const lowerRatio = Number(entry.lower_ratio || 0);
        const tokenIsLower = token === token.toLocaleLowerCase('fr-FR');
        if (
            total >= minCount
            && bestRatio >= minRatio
            && lowerRatio <= maxLowerRatio
            && entry.best !== key
            && (tokenIsLower || (sentenceStart && offset === 0))
        ) {
            return entry.best;
        }
        return token;
    });
    return capitalizeOcrSentenceStarts(lexiconCorrected);
}

async function warmupPpocrLinePipeline() {
    if (ppocrWarmupDone || !ppocrLineDetectorSession || !ppocrRecSession || !ppocrManifest) return;
    const { height, width } = detectorInputSize(ppocrLineDetectorSession);
    const detectorTensor = new ort.Tensor('float32', new Float32Array(3 * height * width), [1, 3, height, width]);
    await ppocrLineDetectorSession.run({
        [ppocrLineDetectorSession.inputNames[0]]: detectorTensor,
    });

    const recHeight = ppocrManifest.image_height || 48;
    const recWidth = ppocrManifest.min_image_width || 960;
    const recTensor = new ort.Tensor('float32', new Float32Array(3 * recHeight * recWidth), [1, 3, recHeight, recWidth]);
    await ppocrRecSession.run({
        [ppocrRecSession.inputNames[0]]: recTensor,
    });
    ppocrWarmupDone = true;
}

async function runPpocrOnBitmap(bitmap, timings, totalStart) {
    const detectStart = performance.now();
    const boxes = await detectLineBoxes(bitmap);
    timings.detectMs = roundMs(performance.now() - detectStart);

    const stitchStart = performance.now();
    const stitched = stitchLineBoxes(bitmap, boxes);
    timings.stitchMs = roundMs(performance.now() - stitchStart);

    const preprocessStart = performance.now();
    const tensor = preprocessPpocrCanvas(stitched);
    timings.preprocessMs = roundMs(performance.now() - preprocessStart);

    const recognizeStart = performance.now();
    const result = await ppocrRecSession.run({
        [ppocrRecSession.inputNames[0]]: tensor,
    });
    timings.recognizeMs = roundMs(performance.now() - recognizeStart);

    const decodeTextStart = performance.now();
    const output = result[ppocrRecSession.outputNames[0]].data;
    const rawText = decodePpocrCtc(output);
    const text = postprocessPpocrText(rawText);
    timings.decodeTextMs = roundMs(performance.now() - decodeTextStart);
    timings.totalMs = roundMs(performance.now() - totalStart);

    return {
        text,
        rawText,
        lineCount: boxes.length,
        provider: ppocrRuntimeProvider || 'wasm',
        timings,
    };
}

async function ocrPpocrv6Line(imageInput) {
    const totalStart = performance.now();
    const timings = {};
    let bitmap = null;

    const decodeStart = performance.now();
    if (typeof ImageBitmap !== 'undefined' && imageInput instanceof ImageBitmap) {
        bitmap = imageInput;
        timings.decodeMs = 0;
    } else {
        bitmap = await createImageBitmap(imageInput);
        timings.decodeMs = roundMs(performance.now() - decodeStart);
    }

    try {
        try {
            return await runPpocrOnBitmap(bitmap, timings, totalStart);
        } catch (err) {
            if (!(ppocrRuntimeProvider || '').includes('webgpu')) throw err;
            const fallbackStart = performance.now();
            await forcePpocrWasmSessions(err);
            timings.providerFallbackMs = roundMs(performance.now() - fallbackStart);
            timings.providerFallback = 'wasm';
            return await runPpocrOnBitmap(bitmap, timings, totalStart);
        }
    } finally {
        bitmap?.close?.();
    }
}

async function handlePpocrRun({ imageBlob, imageBitmap, requestId }) {
    if (!ppocrLineDetectorSession || !ppocrRecSession || !ppocrManifest) {
        self.postMessage({ status: 'error', error: 'Modèle PP-OCRv6 non chargé.', requestId });
        return;
    }
    try {
        const result = await ocrPpocrv6Line(imageBitmap || imageBlob);
        const text = fixFrenchPunctuation(result.text);
        console.log("[Worker] PP-OCRv6 line OCR result:", text, result);
        self.postMessage({
            status: 'complete',
            text,
            requestId,
            lineCount: result.lineCount,
            provider: result.provider,
            timings: result.timings,
        });
    } catch (err) {
        console.error("[Worker PP-OCRv6 Run Error]", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        self.postMessage({ status: 'error', error: `Erreur OCR PP-OCRv6 : ${errorMsg}`, requestId });
    }
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob, imageBitmap, modelKey } = event.data;

    if (type === 'init') {
        try {
            const selectedKey = modelKey || 'ppocrv6Line';
            const selectedModel = MODELS[selectedKey];

            if (!selectedModel) {
                self.postMessage({ status: 'error', error: `Modèle inconnu: ${selectedKey}` });
                return;
            }

            if (selectedModel.runtime === 'onnx') {
                const progressCallback = ({ file, progress }) => {
                    self.postMessage({
                        status: 'download_progress',
                        file,
                        progress: Math.min(Math.max(progress || 0, 0), 100),
                    });
                };
                await loadPpocrLinePipeline(progressCallback, selectedModel);
                currentModelId = selectedModel.id;
                self.postMessage({ status: 'download_progress', file: '', progress: 100 });
                self.postMessage({ status: 'ready', modelKey: selectedKey });
                return;
            }

        } catch (err) {
            console.error("[Worker Init Error]", err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: `Initialisation impossible : ${errorMsg}` });
        }
    }

    if (type === 'run' && (imageBitmap || imageBlob)) {
        const { requestId } = event.data;
        const activeKey = Object.keys(MODELS).find(k => MODELS[k].id === currentModelId) || 'ppocrv6Line';
        const activeModel = MODELS[activeKey];

        if (activeModel?.runtime === 'onnx') {
            if (!ppocrLineDetectorSession || !ppocrRecSession || !ppocrManifest) {
                self.postMessage({ status: 'error', error: 'ModÃ¨le PP-OCRv6 non chargÃ©.', requestId });
                return;
            }
            ppocrRunQueue = ppocrRunQueue
                .catch(() => undefined)
                .then(() => handlePpocrRun({ imageBlob, imageBitmap, requestId }));
            return;
        }
    }
});
