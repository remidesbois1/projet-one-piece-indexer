"use client";

import { useState, useRef, useCallback } from 'react';
import { useDetection } from '@/context/DetectionContext';
import { toast } from 'sonner';

export function useAnnotationDetection({
    imageRef,
    pageId,
    setRectangle,
    setPendingAnnotation,
    setDebugImageUrl,
    runLocalOcr,
    setIsSubmitting,
    setLoadingText
}) {
    const { detectBubbles, detectionStatus, loadDetectionModel, downloadProgress: detectionProgress } = useDetection();
    const [isAutoDetecting, setIsAutoDetecting] = useState(false);
    const detectionQueueRef = useRef([]);
    const [queueLength, setQueueLength] = useState(0);

    const processNextBubble = useCallback(async () => {
        if (!imageRef.current) return;

        if (detectionQueueRef.current.length === 0) {
            setIsAutoDetecting(false);
            setQueueLength(0);
            setRectangle(null);
            toast.success("Détection automatique terminée !");
            return;
        }

        const nextBox = detectionQueueRef.current.shift();
        setQueueLength(detectionQueueRef.current.length);
        setRectangle(nextBox);

        const analysisData = { id_page: parseInt(pageId, 10), ...nextBox, texte_propose: '' };
        setPendingAnnotation(analysisData);
        setDebugImageUrl(null);

        runLocalOcr(nextBox);
    }, [imageRef, pageId, setRectangle, setPendingAnnotation, setDebugImageUrl, runLocalOcr]);

    const handleExecuteDetection = async () => {
        if (!imageRef.current) return;

        try {
            setLoadingText("Détection des bulles...");
            setIsSubmitting(true);

            const response = await fetch(imageRef.current.src);
            const blob = await response.blob();

            const boxes = await detectBubbles(blob);

            if (boxes.length === 0) {
                toast.info("Aucune bulle détectée.");
                setIsSubmitting(false);
                return;
            }

            toast.success(`${boxes.length} bulles détectées !`);

            detectionQueueRef.current = boxes;
            setQueueLength(boxes.length);
            setIsAutoDetecting(true);

            setTimeout(() => {
                processNextBubble();
            }, 100);

        } catch (err) {
            console.error("Detection error:", err);
            toast.error("Erreur lors de la détection: " + err.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    return {
        isAutoDetecting,
        setIsAutoDetecting,
        queueLength,
        detectionStatus,
        loadDetectionModel,
        detectionProgress,
        handleExecuteDetection,
        processNextBubble
    };
}
