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
        <div className="flex flex-none flex-col gap-3 rounded-xl border border-white/12 bg-white/[0.055] p-3 shadow-sm">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-0.5">Détection des bulles</h3>

            {detectionStatus === 'idle' && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={loadDetectionModel}
                    className="h-8 w-full border border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 hover:bg-white/12"
                >
                    <Download size={12} className="mr-1.5" /> Charger le modèle <span className="text-[10px] font-bold text-slate-400">(19.3MB)</span>
                </Button>
            )}
            {detectionStatus === 'loading' && (
                <div className="rounded-lg border border-white/12 bg-white/[0.06] p-2">
                    <div className="mb-1.5 flex justify-between text-[9px] font-bold text-slate-400">
                        <span>
                            {downloadStats?.total > 0 
                                ? `${(downloadStats.loaded / (1024 * 1024)).toFixed(1)}MB / ${(downloadStats.total / (1024 * 1024)).toFixed(1)}MB`
                                : "Téléchargement..."
                            }
                        </span>
                        <span>{Math.round(detectionProgress)}%</span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-white/12">
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
