"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWorker, OCR_MODELS } from '@/context/WorkerContext';
import { analyzeBubble } from '@/lib/geminiClient';
import { cropImage } from '@/lib/utils';
import { toast } from 'sonner';

export function useAnnotationOCR({
    imageRef,
    pageId,
    rectangle,
    pendingAnnotation,
    setPendingAnnotation,
    setIsSubmitting,
    setLoadingText,
    setIsModalOpen,
    setOcrSource,
    setDebugImageUrl,
    setShowApiKeyModal
}) {
    const { worker, modelStatus, loadModel, switchModel, downloadProgress, runOcr, activeModelKey } = useWorker();
    const [preferLocalOCR, setPreferLocalOCR] = useState(false);
    const [geminiKey, setGeminiKey] = useState(null);
    const [ocrResults, setOcrResults] = useState({});
    const lastRequestId = useRef(0);
    const activeRequests = useRef(new Set());
    const apiTaskQueue = useRef([]);
    const isProcessingApi = useRef(false);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setPreferLocalOCR(localStorage.getItem('preferLocalOCR') !== 'false');
            const loadKey = () => setGeminiKey(localStorage.getItem('google_api_key'));
            loadKey();
            window.addEventListener('storage', loadKey);
            return () => window.removeEventListener('storage', loadKey);
        }
    }, []);

    const toggleOcrPreference = () => {
        const newValue = !preferLocalOCR;
        setPreferLocalOCR(newValue);
        localStorage.setItem('preferLocalOCR', JSON.stringify(newValue));
    };

    const handleOcrCompletion = useCallback((requestId, text, source) => {
        setOcrResults(prev => ({ ...prev, [requestId]: text }));
        activeRequests.current.delete(requestId);

        if (requestId === lastRequestId.current) {
            setOcrSource(source);
            setPendingAnnotation(prev => {
                if (!prev) return null;
                return { ...prev, texte_propose: text };
            });
            setIsSubmitting(false);
            setIsModalOpen(true);
        }
    }, [setOcrResults, setOcrSource, setPendingAnnotation, setIsSubmitting, setIsModalOpen]);

    const processNextApiTask = useCallback(async () => {
        if (isProcessingApi.current || apiTaskQueue.current.length === 0) return;

        isProcessingApi.current = true;

        let taskIndex = apiTaskQueue.current.findIndex(t => t.requestId === lastRequestId.current);
        if (taskIndex === -1) taskIndex = 0;

        const { areaToCrop, requestId } = apiTaskQueue.current.splice(taskIndex, 1)[0];

        try {
            const blob = await cropImage(imageRef.current, areaToCrop);
            const response = await fetch('/api/ocr', {
                method: 'POST',
                body: blob
            });

            if (response.ok) {
                const result = await response.json();
                handleOcrCompletion(requestId, result.text, 'poneglyph');
            } else {
                throw new Error("Erreur Serveur Poneglyph");
            }
        } catch (err) {
            console.error("API Task Error:", err);
            activeRequests.current.delete(requestId);
            if (requestId === lastRequestId.current) {
                setIsSubmitting(false);
                setIsModalOpen(true);
                toast.error("Erreur OCR Poneglyph");
            }
        } finally {
            isProcessingApi.current = false;
            setTimeout(() => processNextApiTask(), 50);
        }
    }, [imageRef, handleOcrCompletion, setIsSubmitting, setIsModalOpen]);

    const handleRetryWithCloud = useCallback((dataOverride = null) => {
        const dataToUse = dataOverride || pendingAnnotation;
        if (!dataToUse) return;

        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            if (!pendingAnnotation) setPendingAnnotation(dataToUse);
            setShowApiKeyModal(true);
            return;
        }

        setLoadingText("Analyse Cloud (Google)...");
        setIsSubmitting(true);
        setDebugImageUrl(null);

        analyzeBubble(imageRef.current, dataToUse, storedKey)
            .then(response => {
                setPendingAnnotation(prev => ({ ...prev, texte_propose: response.data.texte_propose }));
                setOcrSource('cloud');
                setIsModalOpen(true);
            })
            .catch(error => {
                if (error.message === "QUOTA_EXCEEDED") {
                    toast.error("Quota API Gemini dépassé !", {
                        description: "Votre clé a atteint sa limite gratuite (RPM/TPM). Réessayez dans une minute ou changez de clé."
                    });
                } else {
                    console.error("Cloud OCR Error:", error);
                    if (error.message?.includes('API key') || error.toString().includes('400')) {
                        localStorage.removeItem('google_api_key');
                        setShowApiKeyModal(true);
                    }
                }
                setIsModalOpen(true);
            })
            .finally(() => setIsSubmitting(false));
    }, [imageRef, pendingAnnotation, setPendingAnnotation, setLoadingText, setIsSubmitting, setDebugImageUrl, setOcrSource, setIsModalOpen, setShowApiKeyModal]);

    const runBackgroundOcr = useCallback(async (areaToCrop, requestId) => {
        try {
            const modelData = OCR_MODELS[activeModelKey];
            if (!modelData || modelData.key === 'gemini') return;
            if (activeRequests.current.has(requestId)) return;

            activeRequests.current.add(requestId);

            if (modelData.key === 'poneglyph') {
                apiTaskQueue.current.push({ areaToCrop, requestId });
                processNextApiTask();
                return;
            }

            if (modelData.type === 'local' && modelStatus === 'ready') {
                const blob = await cropImage(imageRef.current, areaToCrop);
                runOcr(blob, requestId);
            } else {
                activeRequests.current.delete(requestId);
            }
        } catch (err) {
            activeRequests.current.delete(requestId);
            console.error("Background OCR Error:", err);
        }
    }, [activeModelKey, modelStatus, imageRef, runOcr, processNextApiTask]);

    const runLocalOcr = useCallback(async (cropData = null, customRequestId = null) => {
        try {
            const modelData = OCR_MODELS[activeModelKey];
            const areaToCrop = cropData || rectangle || (pendingAnnotation ? { x: pendingAnnotation.x, y: pendingAnnotation.y, w: pendingAnnotation.w, h: pendingAnnotation.h } : null);

            if (!areaToCrop) {
                setIsModalOpen(true);
                return;
            }

            const requestId = customRequestId || Date.now();
            lastRequestId.current = requestId;

            if (ocrResults[requestId] !== undefined) {
                setOcrSource(modelData?.key === 'poneglyph' ? 'poneglyph' : 'local');
                setPendingAnnotation(prev => ({ ...prev, texte_propose: ocrResults[requestId] }));
                setIsModalOpen(true);
                return;
            }

            if (activeRequests.current.has(requestId)) {
                setIsSubmitting(true);
                setLoadingText(modelData?.key === 'poneglyph' ? "Analyse Poneglyph..." : "Analyse Locale...");
                // If it's an API task, trigger process to potentially prioritize it
                if (modelData?.key === 'poneglyph') processNextApiTask();
                return;
            }

            if (!modelData || (modelData.type === 'local' && modelStatus !== 'ready')) {
                setIsModalOpen(true);
                return;
            }

            if (preferLocalOCR && modelData.type !== 'local') {
                setIsModalOpen(true);
                return;
            }
            if (!preferLocalOCR && modelData.type !== 'api') {
                setIsModalOpen(true);
                return;
            }

            if (modelData?.key === 'gemini') {
                handleRetryWithCloud({ id_page: parseInt(pageId, 10), ...areaToCrop, texte_propose: '' });
                return;
            }

            if (modelData?.key === 'poneglyph') {
                activeRequests.current.add(requestId);
                apiTaskQueue.current.push({ areaToCrop, requestId });
                setIsSubmitting(true);
                setLoadingText("Analyse Cloud Poneglyph...");
                processNextApiTask();
                return;
            }

            setLoadingText("Analyse Locale...");
            setIsSubmitting(true);
            activeRequests.current.add(requestId);

            const blob = await cropImage(imageRef.current, areaToCrop);
            runOcr(blob, requestId);
        } catch (err) {
            console.error(err);
            toast.error("Erreur OCR: " + err.message);
            setIsSubmitting(false);
            setIsModalOpen(true);
        }
    }, [activeModelKey, modelStatus, preferLocalOCR, rectangle, pendingAnnotation, pageId, imageRef, handleRetryWithCloud, setLoadingText, setIsSubmitting, setOcrSource, setPendingAnnotation, setIsModalOpen, runOcr, ocrResults, processNextApiTask]);

    useEffect(() => {
        if (!worker) return;

        const handleMessage = async (e) => {
            const { status, text, error, url, requestId } = e.data;

            if (status === 'debug_image') setDebugImageUrl(url);

            if (status === 'complete') {
                if (requestId) {
                    handleOcrCompletion(requestId, text, 'local');
                }
            }

            if (status === 'error' && modelStatus === 'ready') {
                console.error("Erreur OCR:", error);
                if (requestId) activeRequests.current.delete(requestId);
                if (requestId === lastRequestId.current) {
                    setIsSubmitting(false);
                    setIsModalOpen(true);
                }
            }
        };

        worker.addEventListener('message', handleMessage);
        return () => worker.removeEventListener('message', handleMessage);
    }, [worker, modelStatus, setDebugImageUrl, handleOcrCompletion]);

    return {
        preferLocalOCR,
        toggleOcrPreference,
        geminiKey,
        activeModelKey,
        modelStatus,
        loadModel,
        switchModel,
        downloadProgress,
        runLocalOcr,
        runBackgroundOcr,
        ocrResults,
        handleRetryWithCloud
    };
}
