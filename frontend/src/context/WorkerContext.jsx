"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const WorkerContext = createContext();

export const useWorker = () => useContext(WorkerContext);

export const WorkerProvider = ({ children }) => {
    const workerRef = useRef(null);
    const [modelStatus, setModelStatus] = useState('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [currentFile, setCurrentFile] = useState("");

    useEffect(() => {
        if (!workerRef.current && typeof window !== 'undefined') {
            workerRef.current = new Worker(new URL('../workers/ocr.worker.js', import.meta.url), {
                type: 'module'
            });

            workerRef.current.addEventListener('message', (e) => {
                const { status, progress, file, error } = e.data;

                if (status === 'download_progress') {
                    setModelStatus('loading');
                    setDownloadProgress(Math.round(progress || 0));
                    setCurrentFile(file || "");
                }
                if (status === 'ready') {
                    setModelStatus('ready');
                }
                if (status === 'error' && modelStatus === 'loading') {
                    setModelStatus('error');
                    console.error("Erreur chargement modèle:", error);
                }
            });
        }

        return () => {
        };
    }, []);

    const loadModel = () => {
        if (workerRef.current && modelStatus === 'idle') {
            setModelStatus('loading');
            workerRef.current.postMessage({ type: 'init' });
        }
    };

    const runOcr = (blob, requestId = null) => {
        if (workerRef.current && modelStatus === 'ready') {
            workerRef.current.postMessage({ type: 'run', imageBlob: blob, requestId });
        }
    };

    return (
        <WorkerContext.Provider value={{
            worker: workerRef.current,
            modelStatus,
            loadModel,
            downloadProgress,
            runOcr
        }}>
            {children}
        </WorkerContext.Provider>
    );
};
