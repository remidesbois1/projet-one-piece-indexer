"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createAbortError } from '@/lib/searchRequestLifecycle';

const DetectionContext = createContext();

export const useDetection = () => useContext(DetectionContext);

export const DetectionProvider = ({ children }) => {
    const workerRef = useRef(null);
    const [detectionWorker, setDetectionWorker] = useState(null);
    const [detectionStatus, setDetectionStatus] = useState('idle'); 
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStats, setDownloadStats] = useState({ loaded: 0, total: 0 });
    const detectionStatusRef = useRef(detectionStatus);
    const nextDetectionRequestIdRef = useRef(1);

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
            const signal = options.signal;
            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }
            if (!workerRef.current || detectionStatusRef.current !== 'ready') {
                reject(new Error("Modèle de détection non prêt."));
                return;
            }

            const currentWorker = workerRef.current;
            const requestId = `detection-${nextDetectionRequestIdRef.current}`;
            nextDetectionRequestIdRef.current += 1;

            const cleanup = () => {
                currentWorker.removeEventListener('message', handleMessage);
                signal?.removeEventListener('abort', handleAbort);
            };
            const handleAbort = () => {
                cleanup();
                currentWorker.postMessage({ type: 'cancel', requestId });
                reject(createAbortError());
            };
            const handleMessage = (e) => {
                const { status, requestId: responseRequestId, boxes, debug, error } = e.data;
                if (responseRequestId !== requestId) return;
                if (status === 'complete') {
                    cleanup();
                    resolve(options.returnDebug ? { boxes, debug } : boxes);
                }
                if (status === 'error') {
                    cleanup();
                    reject(new Error(error));
                }
            };

            currentWorker.addEventListener('message', handleMessage);
            signal?.addEventListener('abort', handleAbort, { once: true });
            currentWorker.postMessage({
                type: 'run',
                requestId,
                imageBlob: blob,
                debug: Boolean(options.debug || options.returnDebug)
            });
        });
    }, []);

    const detectBubblesPositionsOnly = React.useCallback((blob, { signal } = {}) => {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }
            if (!workerRef.current || detectionStatusRef.current !== 'ready') {
                reject(new Error("Modèle de détection non prêt."));
                return;
            }

            const currentWorker = workerRef.current;
            const requestId = `detection-positions-${nextDetectionRequestIdRef.current}`;
            nextDetectionRequestIdRef.current += 1;

            const cleanup = () => {
                currentWorker.removeEventListener('message', handleMessage);
                signal?.removeEventListener('abort', handleAbort);
            };
            const handleAbort = () => {
                cleanup();
                currentWorker.postMessage({ type: 'cancel', requestId });
                reject(createAbortError());
            };
            const handleMessage = (e) => {
                const { status, requestId: responseRequestId, boxes, error } = e.data;
                if (responseRequestId !== requestId) return;
                if (status === 'complete') {
                    cleanup();
                    resolve(boxes);
                }
                if (status === 'error') {
                    cleanup();
                    reject(new Error(error));
                }
            };

            currentWorker.addEventListener('message', handleMessage);
            signal?.addEventListener('abort', handleAbort, { once: true });
            currentWorker.postMessage({ type: 'run-positions-only', requestId, imageBlob: blob });
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
