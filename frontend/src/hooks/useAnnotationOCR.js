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
    const lastRequestId = useRef(0);

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

    const runLocalOcr = useCallback(async (cropData = null) => {
        try {
            const modelData = OCR_MODELS[activeModelKey];
            const areaToCrop = cropData || rectangle || (pendingAnnotation ? { x: pendingAnnotation.x, y: pendingAnnotation.y, w: pendingAnnotation.w, h: pendingAnnotation.h } : null);
            
            if (!areaToCrop) {
                setIsModalOpen(true);
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
                setLoadingText("Analyse Cloud Poneglyph...");
                setIsSubmitting(true);
                const blob = await cropImage(imageRef.current, areaToCrop);

                const response = await fetch('/api/ocr', {
                    method: 'POST',
                    body: blob
                });

                if (!response.ok) throw new Error("Erreur Serveur Poneglyph (Proxy)");
                const result = await response.json();

                const geometry = cropData || rectangle;
                setOcrSource('poneglyph');
                setPendingAnnotation({
                    id_page: parseInt(pageId, 10),
                    ...geometry,
                    texte_propose: result.text
                });
                setIsSubmitting(false);
                setIsModalOpen(true);
                return;
            }

            setLoadingText("Analyse Locale...");
            setIsSubmitting(true);
            const requestId = Date.now();
            lastRequestId.current = requestId;

            const blob = await cropImage(imageRef.current, areaToCrop);
            runOcr(blob, requestId);
        } catch (err) {
            console.error(err);
            toast.error("Erreur OCR: " + err.message);
            setIsSubmitting(false);
            setIsModalOpen(true);
        }
    }, [activeModelKey, modelStatus, preferLocalOCR, rectangle, pendingAnnotation, pageId, imageRef, handleRetryWithCloud, setLoadingText, setIsSubmitting, setOcrSource, setPendingAnnotation, setIsModalOpen, runOcr]);

    useEffect(() => {
        if (!worker) return;

        const handleMessage = async (e) => {
            const { status, text, error, url, requestId } = e.data;

            if (requestId && requestId !== lastRequestId.current) {
                console.warn(`[OCR] Ignored outdated response for ID ${requestId}`);
                return;
            }

            if (status === 'debug_image') setDebugImageUrl(url);

            if (status === 'complete') {
                setOcrSource('local');
                setPendingAnnotation(prev => {
                    if (!prev) return null;
                    return { ...prev, texte_propose: text };
                });
                setIsSubmitting(false);
                setIsModalOpen(true);
            }

            if (status === 'error' && modelStatus === 'ready') {
                console.error("Erreur OCR:", error);
                setIsSubmitting(false);
            }
        };

        worker.addEventListener('message', handleMessage);
        return () => worker.removeEventListener('message', handleMessage);
    }, [worker, modelStatus, setDebugImageUrl, setOcrSource, setPendingAnnotation, setIsSubmitting, setIsModalOpen]);

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
        handleRetryWithCloud
    };
}
