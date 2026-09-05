import React from 'react';
import { Button } from '@/components/ui/button';
import { ScanLine, Download, Loader2 } from 'lucide-react';

export default function AnnotateBubbleScanner({
    detectionStatus,
    loadDetectionModel,
    detectionProgress,
    downloadStats,
    handleExecuteDetection,
    isSubmitting,
    isAutoDetecting,
    queueLength,
}) {
    return (
        <div className="space-y-2">
            {(detectionStatus === 'idle' || detectionStatus === 'error') && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={loadDetectionModel}
                    disabled={isSubmitting || isAutoDetecting}
                    className="h-10 w-full justify-start border-white/10 bg-white/[0.04] px-3 text-[13px] font-medium text-slate-200 shadow-none hover:bg-white/[0.08]"
                >
                    <Download size={13} className="mr-2 text-slate-400" />
                    {detectionStatus === 'error'
                        ? 'Réessayer la détection'
                        : 'Charger le détecteur de bulles'}
                </Button>
            )}
            {detectionStatus === 'loading' && (
                <div className="rounded-md bg-white/[0.04] px-3 py-2.5">
                    <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">
                        <span>
                            {downloadStats?.total > 0
                                ? `${(downloadStats.loaded / (1024 * 1024)).toFixed(1)}MB / ${(downloadStats.total / (1024 * 1024)).toFixed(1)}MB`
                                : 'Chargement de la détection'}
                        </span>
                        <span>{Math.round(detectionProgress || 0)}%</span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                            className="h-full bg-sky-400 transition-all duration-300"
                            style={{ width: `${detectionProgress || 0}%` }}
                        />
                    </div>
                </div>
            )}
            {detectionStatus === 'ready' && (
                <Button
                    variant="default"
                    onClick={handleExecuteDetection}
                    disabled={isSubmitting || isAutoDetecting}
                    className="h-10 w-full justify-start border border-white/15 bg-transparent px-3 text-[13px] font-medium text-slate-200 shadow-none hover:bg-white/[0.08]"
                >
                    {isAutoDetecting ? (
                        <Loader2 size={14} className="mr-2 animate-spin" />
                    ) : (
                        <ScanLine size={14} className="mr-2" />
                    )}
                    {isAutoDetecting
                        ? `Détection en cours${queueLength > 0 ? ` · ${queueLength} restantes` : '…'}`
                        : 'Détecter les bulles'}
                </Button>
            )}
        </div>
    );
}
