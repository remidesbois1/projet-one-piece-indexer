import React from 'react';
import { Button } from '@/components/ui/button';
import { Check, CloudLightning, Cpu, Download, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OCR_MODELS } from '@/context/WorkerContext';

const COMPARISON_MODELS = Object.values(OCR_MODELS).filter(model => model.key !== 'gemini');

export default function AnnotateOcrModelSelector({
    activeModelKey,
    switchModel,
    modelStatus,
    loadModel,
    downloadProgress,
    selectedOcrModelKeys = [],
    toggleOcrModel,
    geminiKey,
    isTauri = false,
    localTextModelStatus = null,
    localSuryaModelStatus = null,
    isDownloadingLocalTextModel = false,
    isDownloadingLocalSuryaModel = false,
    localTextDownloadState = null,
    localSuryaDownloadState = null,
    localTextDownloadProgress = null,
    localSuryaDownloadProgress = null,
    isLoadingLocalTextModel = false,
    isLoadingLocalSuryaModel = false,
    downloadLocalTextModel,
    downloadLocalSuryaModel,
    loadLocalTextModel,
    loadLocalSuryaModel
}) {
    const getTauriControls = (model) => {
        const isSurya = model.localModelKey === 'surya';
        return {
            status: isSurya ? localSuryaModelStatus : localTextModelStatus,
            downloading: isSurya ? isDownloadingLocalSuryaModel : isDownloadingLocalTextModel,
            loading: isSurya ? isLoadingLocalSuryaModel : isLoadingLocalTextModel,
            downloadState: isSurya ? localSuryaDownloadState : localTextDownloadState,
            downloadProgress: isSurya ? localSuryaDownloadProgress : localTextDownloadProgress,
            download: isSurya ? downloadLocalSuryaModel : downloadLocalTextModel,
            load: isSurya ? loadLocalSuryaModel : loadLocalTextModel
        };
    };

    const renderModelAction = (model) => {
        if (model.runtime === 'tauri') {
            const controls = getTauriControls(model);
            const isDownloading = Boolean(controls.downloading || controls.downloadState?.active);
            const isLoading = Boolean(controls.loading || controls.status?.loading);
            const progress = Number.isFinite(controls.downloadProgress) ? Math.round(controls.downloadProgress) : null;

            if (!isTauri) return <span className="text-[9px] font-semibold text-slate-500">App desktop requise</span>;
            if (isDownloading || isLoading) return <span className="flex items-center gap-1 text-[9px] font-bold text-sky-300"><Loader2 size={11} className="animate-spin" /> {isDownloading ? `Téléchargement${progress !== null ? ` ${progress}%` : ''}` : 'Chargement...'}</span>;
            if (!controls.status?.installed) return <Button type="button" size="sm" variant="outline" onClick={controls.download} className="h-7 border-white/15 bg-white/[0.07] px-2 text-[9px] font-bold text-slate-100 hover:bg-white/12"><Download size={11} className="mr-1" /> Télécharger</Button>;
            if (!controls.status?.ready) return <Button type="button" size="sm" variant="outline" onClick={controls.load} className="h-7 border-white/15 bg-white/[0.07] px-2 text-[9px] font-bold text-slate-100 hover:bg-white/12"><Cpu size={11} className="mr-1" /> Charger</Button>;
            return <span className="text-[9px] font-bold text-emerald-400">Prêt</span>;
        }

        if (model.runtime === 'onnx') {
            const isReady = activeModelKey === model.key && modelStatus === 'ready';
            const isLoading = activeModelKey === model.key && modelStatus === 'loading';
            if (isLoading) return <span className="flex items-center gap-1 text-[9px] font-bold text-sky-300"><Loader2 size={11} className="animate-spin" /> {Math.round(downloadProgress)}%</span>;
            if (isReady) return <span className="text-[9px] font-bold text-emerald-400">Prêt</span>;
            return <Button type="button" size="sm" variant="outline" onClick={() => { switchModel(model.key); loadModel(model.key); }} className="h-7 border-white/15 bg-white/[0.07] px-2 text-[9px] font-bold text-slate-100 hover:bg-white/12"><Download size={11} className="mr-1" /> Charger</Button>;
        }

        return <span className="text-[9px] font-bold text-indigo-300">Prêt</span>;
    };

    return (
        <div className="flex flex-none flex-col gap-3 rounded-xl border border-white/12 bg-white/[0.055] p-3 shadow-sm">
            <div>
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Modèles OCR</h3>
                <p className="mt-1 text-[9px] font-medium leading-relaxed text-slate-500">Cochez les modèles à comparer. Le téléchargement et le chargement se font directement sur chaque modèle.</p>
            </div>

            <div className="flex flex-col gap-1.5">
                {COMPARISON_MODELS.map((model) => {
                    const checked = selectedOcrModelKeys.includes(model.key);
                    const desktopOnly = model.runtime === 'tauri' && !isTauri;
                    return (
                        <div key={model.key} className={cn(
                            'rounded-lg border p-2 transition-colors',
                            checked ? 'border-[#8dbbff]/42 bg-[#3d86ff]/14' : 'border-white/12 bg-white/[0.055]',
                            desktopOnly && 'opacity-55'
                        )}>
                            <div className="flex items-center gap-2">
                                <button type="button" onClick={() => toggleOcrModel(model.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={model.description}>
                                    <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-sky-300 bg-sky-500 text-white' : 'border-white/25 bg-white/[0.04] text-transparent')}><Check size={11} strokeWidth={3} /></span>
                                    {model.runtime === 'tauri' || model.runtime === 'onnx' ? <Cpu size={12} className="shrink-0 text-[#8dbbff]" /> : <CloudLightning size={12} className="shrink-0 text-indigo-400" />}
                                    <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-bold text-slate-200">{model.label}</span><span className="block text-[8px] font-semibold text-slate-400">{model.runtime === 'tauri' ? 'Local desktop' : model.type === 'api' ? 'Modal GPU' : 'Navigateur'} · {model.size}</span></span>
                                </button>
                                <div className="shrink-0">{renderModelAction(model)}</div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="border-t border-white/10 pt-3 text-[9px] text-slate-500"><span className="font-bold text-slate-400">Gemini</span> reste disponible à la demande {geminiKey ? 'avec votre clé API.' : 'après configuration de votre clé API.'}</div>
        </div>
    );
}
