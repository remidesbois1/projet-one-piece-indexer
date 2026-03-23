"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const WorkerContext = createContext();

export const useWorker = () => useContext(WorkerContext);

export const OCR_MODELS = {
    base: {
        key: 'base',
        label: 'TrOCR Base',
        description: 'Rapide (~1.3 Go)',
        cer: '2.90%',
        size: '~1.3 Go',
        type: 'local'
    },
    large: {
        key: 'large',
        label: 'TrOCR Large',
        description: 'Précis (~2.3 Go)',
        cer: '1.83%',
        size: '~2.3 Go',
        type: 'local'
    },
    poneglyph: {
        key: 'poneglyph',
        label: 'Poneglyph',
        description: 'FireRed OCR - Serverless',
        cer: '< 0.8%',
        size: '~4.2 Go (Cloud)',
        type: 'api'
    },
    gemini: {
        key: 'gemini',
        label: 'Gemini 3.1 Flash Lite',
        description: 'Google Gemini API',
        cer: '~ 0.5%',
        size: 'Cloud',
        type: 'api'
    },
    lighton: {
        key: 'lighton',
        label: 'LightON Poneglyph',
        description: 'Serveur Cloud (Modal GPU)',
        cer: '< 0.5%',
        size: 'API Cloud',
        type: 'api'
    }
};

export const WorkerProvider = ({ children }) => {
    const workerRef = useRef(null);
    const [modelStatus, setModelStatus] = useState('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [currentFile, setCurrentFile] = useState("");
    const [activeModelKey, setActiveModelKey] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('ocrModelKey') || 'base';
        }
        return 'base';
    });

    const lightonWorkerRef = useRef(null);

    useEffect(() => {
        if (!workerRef.current && typeof window !== 'undefined') {
            workerRef.current = new Worker(new URL('../workers/ocr.worker.js', import.meta.url), {
                type: 'module'
            });

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

        if (!lightonWorkerRef.current && typeof window !== 'undefined') {
            lightonWorkerRef.current = new Worker(new URL('../workers/lighton.worker.js', import.meta.url), {
                type: 'module'
            });

            lightonWorkerRef.current.addEventListener('message', (e) => {
                const { type, status, progress, text, error, requestId } = e.data;

                if (type === 'progress') {
                    setModelStatus('loading');
                    // MLC Progress is an object usually
                    if (progress && progress.progress) {
                        setDownloadProgress(Math.round(progress.progress * 100));
                        setCurrentFile(progress.text || "Loading LightOnOCR...");
                    }
                }
                if (type === 'ready') {
                    setModelStatus('ready');
                }
                if (type === 'error') {
                    setModelStatus('error');
                    console.error("Worker LightOn Error:", error);
                }
            });
        }

        return () => {
        };
    }, []);

    const loadModel = (modelKey) => {
        const key = modelKey || activeModelKey;
        const modelData = OCR_MODELS[key];

        if (modelData?.type === 'api') {
            setModelStatus('ready');
            return;
        }

        if (modelData?.type === 'api') {
            setModelStatus('ready');
            return;
        }

        if (workerRef.current && (modelStatus === 'idle' || modelStatus === 'error')) {
            setModelStatus('loading');
            setDownloadProgress(0);
            workerRef.current.postMessage({ type: 'init', modelKey: key });
        }
    };

    const switchModel = (newKey) => {
        if (newKey === activeModelKey && modelStatus === 'ready') return;
        localStorage.setItem('ocrModelKey', newKey);
        setActiveModelKey(newKey);

        const modelData = OCR_MODELS[newKey];
        if (modelData?.type === 'api') {
            setModelStatus('ready');
            return;
        }

        // For local models, we just set it to idle. 
        // User must click "Load" to start the worker/download.
        setModelStatus('idle');
        setDownloadProgress(0);
    };

    const runOcr = async (blob, requestId = null) => {
        if (workerRef.current && modelStatus === 'ready') {
            workerRef.current.postMessage({ type: 'run', imageBlob: blob, requestId });
        }
    };

    return (
        <WorkerContext.Provider value={{
            worker: activeModelKey === 'lighton' ? lightonWorkerRef.current : workerRef.current,
            modelStatus,
            loadModel,
            switchModel,
            downloadProgress,
            runOcr,
            activeModelKey,
        }}>
            {children}
        </WorkerContext.Provider>
    );
};
