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
    runBackgroundOcr,
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

        runLocalOcr(nextBox, nextBox.id);
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

            const boxesWithId = boxes.map((box, index) => ({
                ...box,
                id: `auto-${Date.now()}-${index}`
            }));

            // Launch background OCR for all bubbles
            boxesWithId.forEach(box => {
                runBackgroundOcr(box, box.id);
            });

            detectionQueueRef.current = boxesWithId;
            setQueueLength(boxesWithId.length);
            setIsAutoDetecting(true);

            setTimeout(() => {
                processNextBubble();
            }, 100);

        } catch (err) {
            toast.info("Aucune bulle détectée.");
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
        processNextBubble,
        detectBubbles
    };
}
