import React from 'react';
import { Button } from "@/components/ui/button";
import { Sparkles, Download } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AnnotateBubbleScanner({
    detectionStatus,
    loadDetectionModel,
    detectionProgress,
    downloadStats,
    handleExecuteDetection,
    isSubmitting,
    isAutoDetecting,
    queueLength
}) {
    return (
        <div className="flex-none p-3 rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col gap-3">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-0.5">Détection des bulles</h3>

            {detectionStatus === 'idle' && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={loadDetectionModel}
                    className="w-full h-8 text-[11px] font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-600"
                >
                    <Download size={12} className="mr-1.5" /> Charger le modèle <span className="text-[10px] font-bold text-slate-400">(19.3MB)</span>
                </Button>
            )}
            {detectionStatus === 'loading' && (
                <div className="p-2 bg-slate-50 rounded-lg border border-slate-100">
                    <div className="flex justify-between text-[9px] font-bold text-slate-500 mb-1.5">
                        <span>
                            {downloadStats?.total > 0 
                                ? `${(downloadStats.loaded / (1024 * 1024)).toFixed(1)}MB / ${(downloadStats.total / (1024 * 1024)).toFixed(1)}MB`
                                : "Téléchargement..."
                            }
                        </span>
                        <span>{Math.round(detectionProgress)}%</span>
                    </div>
                    <div className="h-1 w-full bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${detectionProgress}%` }} />
                    </div>
                </div>
            )}
            {detectionStatus === 'ready' && (
                <Button
                    variant="default"
                    onClick={handleExecuteDetection}
                    disabled={isSubmitting || isAutoDetecting}
                    className="w-full h-8 bg-indigo-600 hover:bg-indigo-700 text-[11px] font-bold shadow-sm"
                >
                    <Sparkles size={12} className={cn("mr-1.5", isAutoDetecting && "animate-pulse")} />
                    {isAutoDetecting ? `Analyse en cours (${queueLength})` : "Scanner la page"}
                </Button>
            )}
        </div>
    );
}
