"use client";

import { useState, useEffect, useCallback } from 'react';
import { updateBubbleGeometry } from '@/lib/api';
import { toast } from 'sonner';

export function useAnnotationInteractions({
    containerRef,
    imageRef,
    imageDimensions,
    existingBubbles,
    setExistingBubbles,
    pendingAnnotation,
    setPendingAnnotation,
    setRectangle,
    isGuest,
    isMobile,
    pageStatus,
    isSubmitting,
    showApiKeyModal,
    showDescModal
}) {
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [isShiftPressed, setIsShiftPressed] = useState(false);
    const [activeInteraction, setActiveInteraction] = useState({ 
        type: null, 
        handle: null, 
        startX: 0, 
        startY: 0, 
        initialBox: null, 
        targetId: null 
    });
    const [hoveredBubble, setHoveredBubble] = useState(null);

    useEffect(() => {
        const handleKeyDown = (e) => { if (e.key === 'Shift') setIsShiftPressed(true); };
        const handleKeyUp = (e) => { if (e.key === 'Shift') setIsShiftPressed(false); };
        const handleBlur = () => setIsShiftPressed(false);

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, []);

    const getContainerCoords = useCallback((event) => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }, [containerRef]);

    const handleMouseDown = useCallback((event) => {
        if (isGuest || isMobile) return;
        if (pageStatus !== 'not_started' && pageStatus !== 'in_progress') return;
        if (isSubmitting || showApiKeyModal || showDescModal) return;

        event.preventDefault();
        setIsDrawing(true);
        const coords = getContainerCoords(event);
        setStartPoint(coords);
        setEndPoint(coords);
        setRectangle(null);
        setPendingAnnotation(null);
    }, [isGuest, isMobile, pageStatus, isSubmitting, showApiKeyModal, showDescModal, getContainerCoords, setRectangle, setPendingAnnotation]);

    const handleMouseMove = useCallback((event) => {
        const coords = getContainerCoords(event);
        if (coords) setMousePos(coords);
        if (!isDrawing) return;
        event.preventDefault();
        setEndPoint(coords);
    }, [isDrawing, getContainerCoords]);

    const handleMouseUp = useCallback((event) => {
        if (isDrawing) {
            event.preventDefault();
            setIsDrawing(false);

            const imageEl = imageRef.current;
            if (!imageEl || !startPoint || !endPoint || imageEl.naturalWidth === 0) return;

            const scale = imageEl.naturalWidth / imageEl.offsetWidth;
            const currentEndPoint = getContainerCoords(event) || endPoint;

            const unscaledRect = {
                x: Math.min(startPoint.x, currentEndPoint.x),
                y: Math.min(startPoint.y, currentEndPoint.y),
                w: Math.abs(startPoint.x - currentEndPoint.x),
                h: Math.abs(startPoint.y - currentEndPoint.y),
            };

            if (unscaledRect.w > 10 && unscaledRect.h > 10) {
                setRectangle({
                    x: Math.round(unscaledRect.x * scale),
                    y: Math.round(unscaledRect.y * scale),
                    w: Math.round(unscaledRect.w * scale),
                    h: Math.round(unscaledRect.h * scale),
                });
            } else {
                setStartPoint(null);
                setEndPoint(null);
            }
        }

        if (activeInteraction.type) {
            const { targetId } = activeInteraction;

            if (targetId) {
                const currentBox = existingBubbles.find(b => b.id === targetId);

                if (currentBox) {
                    const geometry = {
                        x: currentBox.x,
                        y: currentBox.y,
                        w: currentBox.w,
                        h: currentBox.h
                    };
                    updateBubbleGeometry(targetId, geometry)
                        .then(() => {
                            toast.success("Position mise à jour");
                        })
                        .catch(err => {
                            console.error("Erreur update geometry:", err);
                            toast.error("Erreur lors de la mise à jour de la position");
                        });
                }
            } 
            setActiveInteraction({ type: null, handle: null, startX: 0, startY: 0, initialBox: null, targetId: null });
        }
    }, [isDrawing, imageRef, startPoint, endPoint, getContainerCoords, setRectangle, activeInteraction, existingBubbles]);

    const handleInteractionStart = useCallback((e, type, handle = null, targetBubble = null) => {
        e.stopPropagation();
        e.preventDefault();

        const bubbleToUse = targetBubble || pendingAnnotation;
        if (!bubbleToUse) return;

        setActiveInteraction({
            type,
            handle,
            startX: e.clientX,
            startY: e.clientY,
            targetId: bubbleToUse.id || null,
            initialBox: {
                x: bubbleToUse.x,
                y: bubbleToUse.y,
                w: bubbleToUse.w,
                h: bubbleToUse.h
            }
        });
    }, [pendingAnnotation]);

    useEffect(() => {
        if (!activeInteraction.type) return;

        const handleGlobalMouseMove = (e) => {
            if (!activeInteraction.type || !imageRef.current || !imageDimensions) return;

            const scale = imageRef.current.naturalWidth / imageRef.current.offsetWidth;
            const dx = (e.clientX - activeInteraction.startX) * scale;
            const dy = (e.clientY - activeInteraction.startY) * scale;

            const { initialBox, type, handle, targetId } = activeInteraction;
            let newBox = { ...initialBox };

            if (type === 'move') {
                newBox.x = Math.round(initialBox.x + dx);
                newBox.y = Math.round(initialBox.y + dy);
            } else if (type === 'resize') {
                if (handle.includes('e')) newBox.w = Math.max(20, Math.round(initialBox.w + dx));
                if (handle.includes('s')) newBox.h = Math.max(20, Math.round(initialBox.h + dy));
                if (handle.includes('w')) {
                    const nextW = Math.round(initialBox.w - dx);
                    if (nextW > 20) {
                        newBox.x = Math.round(initialBox.x + dx);
                        newBox.w = nextW;
                    }
                }
                if (handle.includes('n')) {
                    const nextH = Math.round(initialBox.h - dy);
                    if (nextH > 20) {
                        newBox.y = Math.round(initialBox.y + dy);
                        newBox.h = nextH;
                    }
                }
            }

            newBox.x = Math.max(0, Math.min(newBox.x, imageRef.current.naturalWidth - newBox.w));
            newBox.y = Math.max(0, Math.min(newBox.y, imageRef.current.naturalHeight - newBox.h));
            newBox.w = Math.min(newBox.w, imageRef.current.naturalWidth - newBox.x);
            newBox.h = Math.min(newBox.h, imageRef.current.naturalHeight - newBox.y);

            if (targetId) {
                setExistingBubbles(prev => prev.map(b => b.id === targetId ? { ...b, ...newBox } : b));
                if (pendingAnnotation?.id === targetId) {
                    setPendingAnnotation(prev => ({ ...prev, ...newBox }));
                }
            } else {
                setPendingAnnotation(prev => ({ ...prev, ...newBox }));
                setRectangle(newBox);
            }
        };

        const handleGlobalMouseUp = (e) => {
            handleMouseUp(e);
        };

        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [activeInteraction, imageDimensions, imageRef, handleMouseUp, pendingAnnotation, setExistingBubbles, setPendingAnnotation, setRectangle]);

    return {
        isDrawing,
        startPoint,
        endPoint,
        mousePos,
        isShiftPressed,
        hoveredBubble,
        setHoveredBubble,
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
        handleInteractionStart
    };
}
