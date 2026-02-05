"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const DetectionContext = createContext();

export const useDetection = () => useContext(DetectionContext);

export const DetectionProvider = ({ children }) => {
    const workerRef = useRef(null);
    const [detectionStatus, setDetectionStatus] = useState('idle'); // 'idle', 'loading', 'ready', 'error'
    const [downloadProgress, setDownloadProgress] = useState(0);

    // Initialisation unique du Worker au montage de l'app
    useEffect(() => {
        if (!workerRef.current && typeof window !== 'undefined') {
            workerRef.current = new Worker(new URL('../workers/detection.worker.js', import.meta.url), {
                type: 'module'
            });

            workerRef.current.addEventListener('message', (e) => {
                const { status, progress, error } = e.data;

                if (status === 'download_progress') {
                    setDetectionStatus('loading');
                    setDownloadProgress(Math.round(progress || 0));
                }
                if (status === 'ready') {
                    setDetectionStatus('ready');
                }
                if (status === 'error') {
                    setDetectionStatus('error');
                    console.error("Erreur Detection Worker:", error);
                }
            });
        }

    }, []);

    const loadDetectionModel = () => {
        if (workerRef.current && detectionStatus === 'idle') {
            setDetectionStatus('loading');
            workerRef.current.postMessage({ type: 'init' });
        }
    };

    // Returns a promise that resolves with boxes
    const detectBubbles = (blob) => {
        return new Promise((resolve, reject) => {
            if (!workerRef.current || detectionStatus !== 'ready') {
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
            workerRef.current.postMessage({ type: 'run', imageBlob: blob });
        });
    };

    return (
        <DetectionContext.Provider value={{
            detectionWorker: workerRef.current,
            detectionStatus,
            loadDetectionModel,
            downloadProgress,
            detectBubbles
        }}>
            {children}
        </DetectionContext.Provider>
    );
};
