"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWorker, OCR_MODELS } from '@/context/WorkerContext';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
import { analyzeBubble } from '@/lib/geminiClient';
import { capitalizeOcrSentenceStarts } from '@/lib/ocr-utils';
import { postOcrImage } from '@/lib/ocrProxyClient';
import { cropImage, cropImageBitmap } from '@/lib/utils';
import { toast } from 'sonner';

const SELECTABLE_OCR_MODEL_KEYS = Object.values(OCR_MODELS)
    .filter(model => model.key !== 'gemini')
    .map(model => model.key);

export function useAnnotationOCR({
    imageRef,
    rectangle,
    pendingAnnotation,
    setPendingAnnotation,
    setIsSubmitting,
    setLoadingText,
    setIsModalOpen,
    setOcrSource,
    setDebugImageUrl,
    setShowApiKeyModal,
    isSandbox = false
}) {
    const { worker, modelStatus, loadModel, switchModel, downloadProgress, runOcr, activeModelKey } = useWorker();
    const tauriLocalOcr = useTauriLocalOcrContext();
    const [preferLocalOCR, setPreferLocalOCR] = useState(isSandbox);
    const [geminiKey, setGeminiKey] = useState(null);
    const [ocrResults, setOcrResults] = useState({});
    const [selectedOcrModelKeys, setSelectedOcrModelKeys] = useState(() => {
        if (typeof window === 'undefined') return ['ppocrv6Line'];
        try {
            const saved = JSON.parse(localStorage.getItem('selectedOcrModelKeys'));
            const valid = Array.isArray(saved) ? saved.filter(key => SELECTABLE_OCR_MODEL_KEYS.includes(key)) : [];
            return valid.length ? valid : ['ppocrv6Line'];
        } catch {
            return ['ppocrv6Line'];
        }
    });
    const inFlightRequests = useRef(new Map());
    const workerWaiters = useRef(new Map());

    useEffect(() => {
        if (typeof window === 'undefined') return;
        setPreferLocalOCR(isSandbox || localStorage.getItem('preferLocalOCR') !== 'false');
        const loadKey = () => setGeminiKey(localStorage.getItem('google_api_key'));
        loadKey();
        window.addEventListener('storage', loadKey);
        return () => window.removeEventListener('storage', loadKey);
    }, [isSandbox]);

    const toggleOcrPreference = useCallback(() => {
        const newValue = !preferLocalOCR;
        setPreferLocalOCR(newValue);
        localStorage.setItem('preferLocalOCR', JSON.stringify(newValue));
    }, [preferLocalOCR]);

    const toggleOcrModel = useCallback((modelKey) => {
        if (!SELECTABLE_OCR_MODEL_KEYS.includes(modelKey)) return;
        setSelectedOcrModelKeys(previous => {
            const next = previous.includes(modelKey)
                ? previous.filter(key => key !== modelKey)
                : [...previous, modelKey];
            localStorage.setItem('selectedOcrModelKeys', JSON.stringify(next));
            return next;
        });
    }, []);

    const getTauriTextRuntime = useCallback((modelData) => {
        const isSurya = modelData?.localModelKey === 'surya';
        return {
            canRun: isSurya ? tauriLocalOcr.canRunLocalSuryaOcr : tauriLocalOcr.canRunLocalTextOcr,
            status: isSurya ? tauriLocalOcr.localSuryaModelStatus : tauriLocalOcr.localTextModelStatus,
            isDownloading: isSurya ? tauriLocalOcr.isDownloadingLocalSuryaModel : tauriLocalOcr.isDownloadingLocalTextModel,
            runBlob: isSurya ? tauriLocalOcr.runLocalSuryaOcrBlob : tauriLocalOcr.runLocalTextOcrBlob,
            label: modelData?.label || (isSurya ? 'Surya' : 'Poneglyph'),
        };
    }, [tauriLocalOcr]);

    const waitForWorkerResult = useCallback((workerRequestId) => new Promise((resolve, reject) => {
        workerWaiters.current.set(workerRequestId, { resolve, reject });
    }), []);

    useEffect(() => {
        if (!worker) return;
        const handleMessage = (event) => {
            const { status, text, error, url, requestId } = event.data;
            if (status === 'debug_image') setDebugImageUrl(url);
            if (!requestId) return;

            const waiter = workerWaiters.current.get(requestId);
            if (!waiter) return;
            if (status === 'complete') {
                workerWaiters.current.delete(requestId);
                waiter.resolve(text || '');
            }
            if (status === 'error') {
                workerWaiters.current.delete(requestId);
                waiter.reject(new Error(error || 'Erreur OCR locale'));
            }
        };
        worker.addEventListener('message', handleMessage);
        return () => worker.removeEventListener('message', handleMessage);
    }, [worker, setDebugImageUrl]);

    const runModel = useCallback(async (modelData, areaToCrop, requestId) => {
        if (modelData.key === 'lighton') {
            const blob = await cropImage(imageRef.current, areaToCrop);
            const response = await postOcrImage('/api/local_lighton', blob);
            if (!response.ok) throw new Error(`Erreur OCR ${modelData.label}`);
            const result = await response.json();
            return result.text || '';
        }

        if (modelData.runtime === 'tauri') {
            const runtime = getTauriTextRuntime(modelData);
            if (!runtime.canRun) {
                throw new Error(`${runtime.label} n'est pas chargé et prêt.`);
            }
            const blob = await cropImage(imageRef.current, areaToCrop);
            const result = await runtime.runBlob(blob);
            return result?.text || '';
        }

        if (modelData.runtime === 'onnx') {
            if (activeModelKey !== modelData.key || modelStatus !== 'ready') {
                throw new Error(`${modelData.label} n'est pas chargé.`);
            }
            const workerRequestId = `${requestId}:${modelData.key}:${Date.now()}`;
            const result = waitForWorkerResult(workerRequestId);
            const bitmap = await cropImageBitmap(imageRef.current, areaToCrop);
            await runOcr(bitmap, workerRequestId);
            return result;
        }

        throw new Error(`Le moteur ${modelData.label} n'est pas compatible avec la comparaison OCR.`);
    }, [activeModelKey, getTauriTextRuntime, imageRef, modelStatus, runOcr, waitForWorkerResult]);

    const executeSelectedOcr = useCallback((areaToCrop, requestId) => {
        if (inFlightRequests.current.has(requestId)) return inFlightRequests.current.get(requestId);

        const models = selectedOcrModelKeys
            .map(key => OCR_MODELS[key])
            .filter(Boolean);
        const job = Promise.allSettled(models.map(async model => ({
            modelKey: model.key,
            label: model.label,
            text: capitalizeOcrSentenceStarts(await runModel(model, areaToCrop, requestId))
        }))).then(settled => {
            const candidates = settled
                .filter(result => result.status === 'fulfilled')
                .map(result => result.value);
            const failures = settled.flatMap((result, index) => result.status === 'rejected'
                ? [`${models[index]?.label || 'OCR'} : ${result.reason?.message || 'indisponible'}`]
                : []);

            setOcrResults(previous => ({ ...previous, [requestId]: candidates }));
            return { candidates, failures };
        }).finally(() => inFlightRequests.current.delete(requestId));

        inFlightRequests.current.set(requestId, job);
        return job;
    }, [runModel, selectedOcrModelKeys]);

    const applyCandidatesToModal = useCallback((candidates) => {
        const firstText = candidates[0]?.text || '';
        setOcrSource(candidates.length > 1 ? 'multiple' : candidates[0]?.modelKey || null);
        setPendingAnnotation(previous => previous ? {
            ...previous,
            texte_propose: firstText,
            ocr_candidates: candidates
        } : previous);
        setIsModalOpen(true);
    }, [setIsModalOpen, setOcrSource, setPendingAnnotation]);

    const runBackgroundOcr = useCallback(async (areaToCrop, requestId) => {
        try {
            await executeSelectedOcr(areaToCrop, requestId);
        } catch (error) {
            console.error('Background OCR error:', error);
        }
    }, [executeSelectedOcr]);

    const runLocalOcr = useCallback(async (cropData = null, customRequestId = null) => {
        const areaToCrop = cropData || rectangle || (pendingAnnotation ? {
            x: pendingAnnotation.x,
            y: pendingAnnotation.y,
            w: pendingAnnotation.w,
            h: pendingAnnotation.h
        } : null);
        if (!areaToCrop) {
            setIsModalOpen(true);
            return;
        }

        const requestId = customRequestId || Date.now();
        setLoadingText(selectedOcrModelKeys.length > 1
            ? `Analyse de ${selectedOcrModelKeys.length} modèles OCR...`
            : 'Analyse OCR...');
        setIsSubmitting(true);
        setDebugImageUrl(null);

        try {
            const { candidates, failures } = await executeSelectedOcr(areaToCrop, requestId);
            if (failures.length) {
                toast.warning(`${failures.length} modèle${failures.length > 1 ? 's' : ''} OCR indisponible${failures.length > 1 ? 's' : ''}.`, {
                    description: failures.join(' · ')
                });
            }
            if (!candidates.length) {
                toast.error('Aucun modèle OCR sélectionné n’a pu traiter cette bulle.');
            }
            applyCandidatesToModal(candidates);
        } catch (error) {
            console.error('OCR error:', error);
            toast.error(`Erreur OCR : ${error.message}`);
            setIsModalOpen(true);
        } finally {
            setIsSubmitting(false);
        }
    }, [applyCandidatesToModal, executeSelectedOcr, pendingAnnotation, rectangle, selectedOcrModelKeys.length, setDebugImageUrl, setIsModalOpen, setIsSubmitting, setLoadingText]);

    const handleRetryWithCloud = useCallback((dataOverride = null) => {
        const dataToUse = dataOverride || pendingAnnotation;
        if (!dataToUse) return;
        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            if (!pendingAnnotation) setPendingAnnotation(dataToUse);
            setShowApiKeyModal(true);
            return;
        }
        setLoadingText('Analyse Cloud (Google)...');
        setIsSubmitting(true);
        setDebugImageUrl(null);
        analyzeBubble(imageRef.current, dataToUse, storedKey)
            .then(response => {
                setPendingAnnotation(previous => ({
                    ...previous,
                    texte_propose: capitalizeOcrSentenceStarts(response.data.texte_propose),
                    ocr_candidates: []
                }));
                setOcrSource('cloud');
                setIsModalOpen(true);
            })
            .catch(error => {
                console.error('Cloud OCR error:', error);
                if (error.message === 'QUOTA_EXCEEDED') toast.error('Quota API Gemini dépassé.');
                setIsModalOpen(true);
            })
            .finally(() => setIsSubmitting(false));
    }, [imageRef, pendingAnnotation, setDebugImageUrl, setIsModalOpen, setIsSubmitting, setLoadingText, setOcrSource, setPendingAnnotation, setShowApiKeyModal]);

    return {
        preferLocalOCR,
        toggleOcrPreference,
        geminiKey,
        activeModelKey,
        modelStatus,
        loadModel,
        switchModel,
        downloadProgress,
        selectedOcrModelKeys,
        toggleOcrModel,
        runLocalOcr,
        runBackgroundOcr,
        ocrResults,
        handleRetryWithCloud
    };
}
