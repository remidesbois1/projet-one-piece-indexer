import React from 'react';
import { 
    Dialog, 
    DialogContent, 
    DialogHeader, 
    DialogTitle, 
    DialogDescription, 
    DialogFooter 
} from "@/components/ui/dialog";
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
    OCR_MODELS
}) {
    return (
        <Dialog
            open={isOpen}
            onOpenChange={(open) => {
                if (!open) {
                    setIsModalOpen(false);
                    setIsSubmitting(false);
                    if (isAutoDetecting) {
                        setIsAutoDetecting(false);
                    }
                    setPendingAnnotation(null);
                    setDebugImageUrl(null);
                    setRectangle(null);
                }
            }}
        >
            <DialogContent
                className="max-w-none w-full h-full bg-transparent border-0 shadow-none p-0 flex items-center justify-end pr-8 pointer-events-none top-0 left-0 translate-x-0 translate-y-0"
                showCloseButton={false}
                aria-describedby={undefined}
            >
                <div className="sr-only">
                    <DialogTitle>Édition de l'annotation</DialogTitle>
                    <DialogDescription>Zone d'édition</DialogDescription>
                </div>

                {pendingAnnotation && (
                    <div className="pointer-events-auto flex flex-col items-center gap-2">
                        <DraggableWrapper
                            title={
                                <div className="flex items-center gap-2">
                                    {pendingAnnotation?.id ? "Modifier" : "Nouvelle"} annotation
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
                            onClose={() => {
                                setPendingAnnotation(null);
                                setRectangle(null);
                                setDebugImageUrl(null);
                                setIsModalOpen(false);
                                setIsSubmitting(false);
                            }}
                            className="w-full max-w-lg"
                        >
                            <div className="p-6">
                                <ValidationForm
                                    annotationData={pendingAnnotation}
                                    onValidationSuccess={handleSuccess}
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
                                            className="max-h-24 object-contain border border-slate-200 shadow-sm rounded bg-white p-1"
                                        />
                                    </div>
                                )}

                                <div className="mt-4 pt-4 border-t border-slate-100 flex justify-center">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs text-slate-500 hover:text-slate-900"
                                        onClick={() => runLocalOcr()}
                                    >
                                        {OCR_MODELS[activeModelKey]?.type === 'local' ? (
                                            <><Sparkles className="h-3 w-3 mr-1 text-indigo-500" /> Essayer un modèle Cloud</>
                                        ) : (
                                            <><RotateCcw className="h-3 w-3 mr-1" /> Relancer l'analyse {OCR_MODELS[activeModelKey]?.label}</>
                                        )}
                                    </Button>
                                </div>
                            </div>
                        </DraggableWrapper>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
