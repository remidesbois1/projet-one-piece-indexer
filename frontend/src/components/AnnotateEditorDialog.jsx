import React, { useCallback, useEffect } from 'react';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cpu, CloudLightning, Sparkles, RotateCcw } from "lucide-react";
import DraggableWrapper from '@/components/DraggableWrapper';
import ValidationForm from '@/components/ValidationForm';

export default function AnnotateEditorDialog({
    isOpen,
    setIsModalOpen,
    setIsSubmitting,
    isAutoDetecting,
    setIsAutoDetecting,
    setPendingAnnotation,
    setDebugImageUrl,
    setRectangle,
    pendingAnnotation,
    ocrSource,
    handleSuccess,
    processNextBubble,
    debugImageUrl,
    runLocalOcr,
    activeModelKey,
    OCR_MODELS,
    isSandbox = false
}) {
    const closeEditor = useCallback(() => {
        setPendingAnnotation(null);
        setRectangle(null);
        setDebugImageUrl(null);
        setIsModalOpen(false);
        setIsSubmitting(false);
    }, [setDebugImageUrl, setIsModalOpen, setIsSubmitting, setPendingAnnotation, setRectangle]);

    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            if (isAutoDetecting) {
                setIsAutoDetecting(false);
            }
            closeEditor();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [closeEditor, isOpen, isAutoDetecting, setIsAutoDetecting]);

    if (!isOpen || !pendingAnnotation) return null;

    return (
        <div className="fixed inset-0 z-50 flex pointer-events-none items-center justify-center p-4">
            <div className="sr-only">
                <h2 id="annotation-editor-title">{"Edition de l'annotation"}</h2>
                <p id="annotation-editor-description">{"Zone d'edition"}</p>
            </div>

            <div
                role="dialog"
                aria-modal="false"
                aria-labelledby="annotation-editor-title"
                aria-describedby="annotation-editor-description"
                className="pointer-events-auto w-[min(28rem,calc(100vw-2rem))]"
                style={{
                    background: 'transparent',
                    backdropFilter: 'none',
                    WebkitBackdropFilter: 'none',
                    borderColor: 'transparent'
                }}
            >
                <DraggableWrapper
                    title={
                        <div className="flex items-center gap-2">
                            {pendingAnnotation?.id && typeof pendingAnnotation.id !== 'string' ? "Modifier" : "Nouvelle"} annotation
                            {ocrSource === 'local' && (
                                <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-200 bg-emerald-50">
                                    <Cpu className="h-3 w-3 mr-1" /> Local IA
                                </Badge>
                            )}
                            {ocrSource === 'cloud' && (
                                <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-200 bg-blue-50">
                                    <CloudLightning className="h-3 w-3 mr-1" /> Cloud IA
                                </Badge>
                            )}
                        </div>
                    }
                    onClose={closeEditor}
                    className="w-full"
                    tone="dark"
                >
                    <div className="p-6">
                        <ValidationForm
                            annotationData={pendingAnnotation}
                            onValidationSuccess={handleSuccess}
                            isSandbox={isSandbox}
                            tone="dark"
                            onCancel={() => {
                                setPendingAnnotation(null);
                                setDebugImageUrl(null);
                                setIsModalOpen(false);
                                setIsSubmitting(false);

                                if (isAutoDetecting) {
                                    setTimeout(() => processNextBubble(), 100);
                                } else {
                                    setRectangle(null);
                                }
                            }}
                        />

                        {debugImageUrl && (
                            <div className="mt-4 flex justify-center">
                                <img
                                    src={debugImageUrl}
                                    alt="Debug"
                                    className="max-h-24 object-contain border border-white/15 shadow-sm rounded bg-[#ffffff] p-1"
                                />
                            </div>
                        )}

                        {!isSandbox && (
                            <div className="mt-4 pt-4 border-t border-slate-100 flex justify-center">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs text-slate-500 hover:text-slate-900"
                                    onClick={() => runLocalOcr()}
                                >
                                    {OCR_MODELS[activeModelKey]?.type === 'local' ? (
                                        <><Sparkles className="h-3 w-3 mr-1 text-indigo-500" /> Essayer un modele Cloud</>
                                    ) : (
                                        <><RotateCcw className="h-3 w-3 mr-1" /> {"Relancer l'analyse"} {OCR_MODELS[activeModelKey]?.label}</>
                                    )}
                                </Button>
                            </div>
                        )}
                    </div>
                </DraggableWrapper>
            </div>
        </div>
    );
}
