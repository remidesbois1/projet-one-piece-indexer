"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const RerankContext = createContext();

export const useRerankWorker = () => useContext(RerankContext);

export const RerankProvider = ({ children }) => {
    const workerRef = useRef(null);
    const [modelStatus, setModelStatus] = useState('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);

    useEffect(() => {
        if (!workerRef.current && typeof window !== 'undefined') {
            workerRef.current = new Worker(new URL('../workers/rerank.worker.js', import.meta.url), {
                type: 'module'
            });

            workerRef.current.addEventListener('message', (e) => {
                const { status, progress, error } = e.data;

                if (status === 'download_progress') {
                    setModelStatus('loading');
                    setDownloadProgress(Math.round(progress || 0));
                }
                if (status === 'ready') {
                    setModelStatus('ready');
                }
                if (status === 'error') {
                    setModelStatus('error');
                    console.error("Rerank Worker Error:", error);
                }
            });
        }

        return () => {
            if (workerRef.current) {
                workerRef.current.terminate();
                workerRef.current = null;
            }
        };
    }, []);

    const loadModel = () => {
        if (workerRef.current && modelStatus === 'idle') {
            setModelStatus('loading');
            workerRef.current.postMessage({ type: 'init' });
        }
    };

    const rerank = (query, documents) => {
        return new Promise((resolve, reject) => {
            if (!workerRef.current || modelStatus !== 'ready') {
                return reject(new Error("Rerank model not ready"));
            }

            const handler = (e) => {
                const { status, results, error } = e.data;
                if (status === 'complete') {
                    workerRef.current.removeEventListener('message', handler);
                    resolve(results);
                }
                if (status === 'error') {
                    workerRef.current.removeEventListener('message', handler);
                    reject(new Error(error));
                }
            };

            workerRef.current.addEventListener('message', handler);
            workerRef.current.postMessage({ type: 'rerank', query, documents });
        });
    };

    return (
        <RerankContext.Provider value={{
            worker: workerRef.current,
            modelStatus,
            loadModel,
            downloadProgress,
            rerank
        }}>
            {children}
        </RerankContext.Provider>
    );
};
