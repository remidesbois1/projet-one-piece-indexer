"use client";
import React, { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { formatBenchmarkContext, formatRegistryMetric, OCR_MODEL_REGISTRY_IDS } from '@/lib/modelRegistry';

const WorkerContext = createContext();

export const useWorker = () => useContext(WorkerContext);

const DEFAULT_OCR_MODEL_KEY = 'ppocrv6Line';

export const OCR_MODELS = {
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
    const workerRef = useRef(null);
    const [workerInstance, setWorkerInstance] = useState(null);
    const [modelStatus, setModelStatus] = useState('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [currentFile, setCurrentFile] = useState("");
    const [activeModelKey, setActiveModelKey] = useState(() => {
        if (typeof window !== 'undefined') {
            const storedKey = localStorage.getItem('ocrModelKey');
            return OCR_MODELS[storedKey] ? storedKey : DEFAULT_OCR_MODEL_KEY;
        }
        return DEFAULT_OCR_MODEL_KEY;
    });

    useEffect(() => {
        if (!workerRef.current && typeof window !== 'undefined') {
            workerRef.current = new Worker(new URL('../workers/ocr.worker.js', import.meta.url), {
                type: 'module'
            });
            setWorkerInstance(workerRef.current);

            workerRef.current.addEventListener('message', (e) => {
                const { status, progress, file, error, modelKey } = e.data;

                if (status === 'download_progress') {
                    setModelStatus('loading');
                    setDownloadProgress(Math.round(progress || 0));
                    setCurrentFile(file || "");
                }
                if (status === 'ready') {
                    setModelStatus('ready');
                    if (modelKey) setActiveModelKey(modelKey);
                }
                if (status === 'error' && (modelStatus === 'loading' || modelStatus === 'switching')) {
                    setModelStatus('error');
                    console.error("Erreur chargement modèle:", error);
                }
            });
        }

        return () => {
        };
    }, []);

    const loadModel = useCallback((modelKey) => {
        const key = modelKey || activeModelKey;
        const modelData = OCR_MODELS[key];

        if (modelData?.type === 'api' || modelData?.runtime === 'tauri') {
            setModelStatus('ready');
            return;
        }

        if (workerRef.current && (modelStatus === 'idle' || modelStatus === 'error' || key !== activeModelKey)) {
            setModelStatus('loading');
            setDownloadProgress(0);
            workerRef.current.postMessage({ type: 'init', modelKey: key });
        }
    }, [activeModelKey, modelStatus]);

    const switchModel = useCallback((newKey) => {
        if (newKey === activeModelKey && modelStatus === 'ready') return;
        localStorage.setItem('ocrModelKey', newKey);
        setActiveModelKey(newKey);

        const modelData = OCR_MODELS[newKey];
        if (modelData?.type === 'api') {
            setModelStatus('ready');
            return;
        }

        if (modelData?.runtime === 'tauri') {
            setModelStatus('idle');
            setDownloadProgress(0);
            return;
        }

        setModelStatus('idle');
        setDownloadProgress(0);
    }, [activeModelKey, modelStatus]);

    const runOcr = useCallback(async (imageInput, requestId = null) => {
        if (workerRef.current && modelStatus === 'ready') {
            const isBitmap = typeof ImageBitmap !== 'undefined' && imageInput instanceof ImageBitmap;
            const payload = isBitmap
                ? { type: 'run', imageBitmap: imageInput, requestId }
                : { type: 'run', imageBlob: imageInput, requestId };
            workerRef.current.postMessage(payload, isBitmap ? [imageInput] : []);
        }
    }, [modelStatus]);

    const value = useMemo(() => ({
        worker: workerInstance,
        modelStatus,
        loadModel,
        switchModel,
        downloadProgress,
        runOcr,
        activeModelKey,
    }), [workerInstance, modelStatus, loadModel, switchModel, downloadProgress, runOcr, activeModelKey]);

    return (
        <WorkerContext.Provider value={value}>
            {children}
        </WorkerContext.Provider>
    );
};
