"use client";
import React, { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { formatBenchmarkContext, formatRegistryMetric, OCR_MODEL_REGISTRY_IDS } from '@/lib/modelRegistry';

const WorkerContext = createContext();

export const useWorker = () => useContext(WorkerContext);

const DEFAULT_OCR_MODEL_KEY = 'ppocrv6Line';

export const OCR_MODELS = {
    falconWebgpu: {
        key: 'falconWebgpu',
        label: 'Falcon-OCR',
        description: 'Bulles entières · WebGPU dans le navigateur',
        cer: 'ONNX · précision mixte',
        benchmark: 'Modèle final entraîné sur toutes les bulles ; pas de test indépendant',
        size: '~618 Mo',
        type: 'local',
        runtime: 'onnx'
    },
    ppocrv6Line: {
        key: 'ppocrv6Line',
        label: 'PP-OCRv6',
        description: 'YOLO lignes + OCR ONNX',
        cer: formatRegistryMetric(OCR_MODEL_REGISTRY_IDS.ppocrv6Line),
        benchmark: formatBenchmarkContext(OCR_MODEL_REGISTRY_IDS.ppocrv6Line),
        size: '~87 Mo',
        type: 'local',
        runtime: 'onnx'
    },
    poneglyphLocal: {
        key: 'poneglyphLocal',
        label: 'Poneglyph',
        description: 'Inference locale via Tauri',
        cer: formatRegistryMetric(OCR_MODEL_REGISTRY_IDS.poneglyphLocal),
        benchmark: formatBenchmarkContext(OCR_MODEL_REGISTRY_IDS.poneglyphLocal),
        size: '~4 Go',
        type: 'local',
        runtime: 'tauri',
        localModelKey: 'base'
    },
    suryaLocal: {
        key: 'suryaLocal',
        label: 'Surya',
        description: 'Inference locale via Tauri',
        cer: formatRegistryMetric(OCR_MODEL_REGISTRY_IDS.suryaLocal),
        benchmark: formatBenchmarkContext(OCR_MODEL_REGISTRY_IDS.suryaLocal),
        size: '~4 Go',
        type: 'local',
        runtime: 'tauri',
        localModelKey: 'surya'
    },
    gemini: {
        key: 'gemini',
        label: 'Gemini 3.1 Flash Lite',
        description: 'Google Gemini API',
        cer: formatRegistryMetric(OCR_MODEL_REGISTRY_IDS.gemini),
        benchmark: formatBenchmarkContext(OCR_MODEL_REGISTRY_IDS.gemini),
        size: 'Cloud',
        type: 'api'
    },
    lighton: {
        key: 'lighton',
        label: 'LightOn OCR',
        description: 'Inference OCR Modal GPU',
        cer: formatRegistryMetric(OCR_MODEL_REGISTRY_IDS.lighton),
        benchmark: formatBenchmarkContext(OCR_MODEL_REGISTRY_IDS.lighton),
        size: 'API Cloud',
        type: 'api'
    }
};

export const WorkerProvider = ({ children }) => {
    const entries = useRef(new Map());
    const [workers, setWorkers] = useState({});
    const [modelStates, setModelStates] = useState({});
    const [activeModelKey, setActiveModelKey] = useState(() => {
        if (typeof window !== 'undefined') {
            const storedKey = localStorage.getItem('ocrModelKey');
            return OCR_MODELS[storedKey] ? storedKey : DEFAULT_OCR_MODEL_KEY;
        }
        return DEFAULT_OCR_MODEL_KEY;
    });

    useEffect(() => () => {
        for (const entry of entries.current.values()) entry.worker.terminate();
        entries.current.clear();
    }, []);

    const loadModel = useCallback((modelKey) => {
        const key = modelKey || activeModelKey;
        if (OCR_MODELS[key]?.runtime !== 'onnx') return;
        let entry = entries.current.get(key);
        if (entry?.status === 'loading' || entry?.status === 'ready') return;
        if (!entry) {
            const worker = key === 'falconWebgpu'
                ? new Worker(new URL('../workers/falcon.worker.js', import.meta.url), { type: 'module' })
                : new Worker(new URL('../workers/ocr.worker.js', import.meta.url), { type: 'module' });
            entry = { worker, status: 'idle' };
            entries.current.set(key, entry);
            const update = (state) => {
                entry.status = state.status;
                setModelStates(previous => ({ ...previous, [key]: { ...previous[key], ...state } }));
            };
            worker.addEventListener('message', ({ data }) => {
                if (data.status === 'download_progress') update({ status: 'loading', progress: Math.round(data.progress || 0), file: data.file || '' });
                if (data.status === 'ready') update({ status: 'ready', progress: 100 });
                if (data.status === 'error' && !data.requestId) update({ status: 'error', error: data.error });
            });
            worker.addEventListener('error', (event) => update({ status: 'error', error: event.message }));
            setWorkers(previous => ({ ...previous, [key]: worker }));
        }
        entry.status = 'loading';
        setModelStates(previous => ({ ...previous, [key]: { status: 'loading', progress: 0 } }));
        entry.worker.postMessage({ type: 'init', modelKey: key });
    }, [activeModelKey]);

    const switchModel = useCallback((key) => {
        if (!OCR_MODELS[key]) return;
        localStorage.setItem('ocrModelKey', key);
        setActiveModelKey(key);
    }, []);

    const runOcr = useCallback(async (imageInput, requestId = null, modelKey = activeModelKey) => {
        const entry = entries.current.get(modelKey);
        if (entry?.status !== 'ready') throw new Error(`${OCR_MODELS[modelKey]?.label || modelKey} n'est pas chargé.`);
        const isBitmap = typeof ImageBitmap !== 'undefined' && imageInput instanceof ImageBitmap;
        const payload = isBitmap
            ? { type: 'run', imageBitmap: imageInput, requestId }
            : { type: 'run', imageBlob: imageInput, requestId };
        entry.worker.postMessage(payload, isBitmap ? [imageInput] : []);
    }, [activeModelKey]);

    const value = useMemo(() => ({
        workers,
        modelStates,
        worker: workers[activeModelKey] || null,
        modelStatus: modelStates[activeModelKey]?.status || (OCR_MODELS[activeModelKey]?.type === 'api' ? 'ready' : 'idle'),
        downloadProgress: modelStates[activeModelKey]?.progress || 0,
        loadModel,
        switchModel,
        runOcr,
        activeModelKey,
    }), [workers, modelStates, loadModel, switchModel, runOcr, activeModelKey]);

    return <WorkerContext.Provider value={value}>{children}</WorkerContext.Provider>;
};
