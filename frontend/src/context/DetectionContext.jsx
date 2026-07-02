"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const DetectionContext = createContext();

export const useDetection = () => useContext(DetectionContext);

export const DetectionProvider = ({ children }) => {
    const workerRef = useRef(null);
    const [detectionWorker, setDetectionWorker] = useState(null);
    const [detectionStatus, setDetectionStatus] = useState('idle'); 
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStats, setDownloadStats] = useState({ loaded: 0, total: 0 });
    const detectionStatusRef = useRef(detectionStatus);

    useEffect(() => {
        detectionStatusRef.current = detectionStatus;
    }, [detectionStatus]);

    
    useEffect(() => {
        if (!workerRef.current && typeof window !== 'undefined') {
            workerRef.current = new Worker(new URL('../workers/detection.worker.js', import.meta.url), {
                type: 'module'
            });
            setDetectionWorker(workerRef.current);

            workerRef.current.addEventListener('message', (e) => {
                const { status, progress, loadedBytes, totalBytes } = e.data;

                if (status === 'download_progress') {
                    setDetectionStatus('loading');
                    setDownloadProgress(Math.round(progress || 0));
                    if (loadedBytes && totalBytes) {
                        setDownloadStats({ loaded: loadedBytes, total: totalBytes });
                    }
                }
                if (status === 'ready') {
                    setDetectionStatus('ready');
                }
                if (status === 'error') {
                    setDetectionStatus('ready');
                }
            });
        }

    }, []);

    const loadDetectionModel = React.useCallback(() => {
        if (workerRef.current && detectionStatus === 'idle') {
            setDetectionStatus('loading');
            workerRef.current.postMessage({ type: 'init' });
        }
    }, [detectionStatus]);

    
    const detectBubbles = React.useCallback((blob, options = {}) => {
        return new Promise((resolve, reject) => {
            if (!workerRef.current || detectionStatusRef.current !== 'ready') {
                return reject(new Error("Modèle de détection non prêt."));
            }

            const handleMessage = (e) => {
                const { status, boxes, debug, error } = e.data;
                if (status === 'complete') {
                    workerRef.current.removeEventListener('message', handleMessage);
                    resolve(options.returnDebug ? { boxes, debug } : boxes);
                }
                if (status === 'error') {
                    workerRef.current.removeEventListener('message', handleMessage);
                    reject(new Error(error));
                }
            };

            workerRef.current.addEventListener('message', handleMessage);
            workerRef.current.postMessage({
                type: 'run',
                imageBlob: blob,
                debug: Boolean(options.debug || options.returnDebug)
            });
        });
    }, []);

    const detectBubblesPositionsOnly = React.useCallback((blob) => {
        return new Promise((resolve, reject) => {
            if (!workerRef.current || detectionStatusRef.current !== 'ready') {
                return reject(new Error("Modèle de détection non prêt."));
            }

            const handleMessage = (e) => {
                const { status, boxes, error } = e.data;
                if (status === 'complete') {
                    workerRef.current.removeEventListener('message', handleMessage);
                    resolve(boxes);
                }
                if (status === 'error') {
                    workerRef.current.removeEventListener('message', handleMessage);
                    reject(new Error(error));
                }
            };

            workerRef.current.addEventListener('message', handleMessage);
            workerRef.current.postMessage({ type: 'run-positions-only', imageBlob: blob });
        });
    }, []);

    return (
        <DetectionContext.Provider value={{
            detectionWorker,
            detectionStatus,
            loadDetectionModel,
            downloadProgress,
            downloadStats,
            detectBubbles,
            detectBubblesPositionsOnly
        }}>
            {children}
        </DetectionContext.Provider>
    );
};
