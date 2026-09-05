import React from 'react';
import { Button } from '@/components/ui/button';
import { Cpu, Download, Loader2 } from 'lucide-react';
import { OCR_MODELS } from '@/context/WorkerContext';
import { isSelectableOcrModel } from '@/lib/ocrModelAvailability';

const COMPARISON_MODELS = Object.values(OCR_MODELS).filter(
    (model) => model.key !== 'gemini'
);

export default function AnnotateOcrModelSelector({
    activeModelKey,
    switchModel,
    modelStatus,
    loadModel,
    downloadProgress,
    selectedOcrModelKeys = [],
    toggleOcrModel,
    isSandbox = false,
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
    loadLocalSuryaModel,
}) {
    const getTauriControls = (model) => {
        const isSurya = model.localModelKey === 'surya';
        return {
            status: isSurya ? localSuryaModelStatus : localTextModelStatus,
            downloading: isSurya
                ? isDownloadingLocalSuryaModel
                : isDownloadingLocalTextModel,
            loading: isSurya
                ? isLoadingLocalSuryaModel
                : isLoadingLocalTextModel,
            downloadState: isSurya
                ? localSuryaDownloadState
                : localTextDownloadState,
            downloadProgress: isSurya
                ? localSuryaDownloadProgress
                : localTextDownloadProgress,
            download: isSurya
                ? downloadLocalSuryaModel
                : downloadLocalTextModel,
            load: isSurya ? loadLocalSuryaModel : loadLocalTextModel,
        };
    };

    const renderModelAction = (model) => {
        if (model.runtime === 'tauri') {
            const controls = getTauriControls(model);
            const isDownloading = Boolean(
                controls.downloading || controls.downloadState?.active
            );
            const isLoading = Boolean(
                controls.loading || controls.status?.loading
            );
            const progress = Number.isFinite(controls.downloadProgress)
                ? Math.round(controls.downloadProgress)
                : null;

            if (!isTauri)
                return (
                    <span className="text-xs font-semibold text-slate-500">
                        App desktop requise
                    </span>
                );
            if (isDownloading || isLoading)
                return (
                    <span className="flex items-center gap-1 text-xs font-medium text-sky-300">
                        <Loader2 size={11} className="animate-spin" />{' '}
                        {isDownloading
                            ? `Téléchargement${progress !== null ? ` ${progress}%` : ''}`
                            : 'Chargement...'}
                    </span>
                );
            if (controls.status?.error && controls.status?.installed)
                return (
                    <span role="status" className="text-xs text-amber-300">
                        {controls.status.error}
                    </span>
                );
            if (!controls.status?.installed)
                return (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={controls.download}
                        aria-label={`Télécharger ${model.label}`}
                        disabled={!controls.download}
                        className="h-8 border-white/15 bg-white/[0.07] px-2 text-xs font-medium text-slate-100 hover:bg-white/12"
                    >
                        <Download size={11} className="mr-1" /> Télécharger
                    </Button>
                );
            if (!controls.status?.ready)
                return (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={controls.load}
                        aria-label={`Charger ${model.label}`}
                        disabled={!controls.load}
                        className="h-8 border-white/15 bg-white/[0.07] px-2 text-xs font-medium text-slate-100 hover:bg-white/12"
                    >
                        <Cpu size={11} className="mr-1" /> Charger
                    </Button>
                );
            return null;
        }

        if (model.runtime === 'onnx') {
            const isReady =
                activeModelKey === model.key && modelStatus === 'ready';
            const isLoading =
                activeModelKey === model.key && modelStatus === 'loading';
            if (isLoading)
                return (
                    <span className="flex items-center gap-1 text-xs font-medium text-sky-300">
                        <Loader2 size={11} className="animate-spin" />{' '}
                        {Math.round(downloadProgress || 0)}%
                    </span>
                );
            if (isReady) return null;
            return (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                        switchModel(model.key);
                        loadModel(model.key);
                    }}
                    className="h-8 border-white/15 bg-white/[0.07] px-2 text-xs font-medium text-slate-100 hover:bg-white/12"
                >
                    <Download size={11} className="mr-1" /> Charger
                </Button>
            );
        }

        return null;
    };

    return (
        <div className="divide-y divide-white/[0.06]">
            {COMPARISON_MODELS.filter(
                (model) => isSelectableOcrModel(model, isSandbox) && (isTauri || model.runtime !== 'tauri')
            ).map((model) => {
                const checked = selectedOcrModelKeys.includes(model.key);
                const action = renderModelAction(model);
                return (
                    <div key={model.key} className="py-2">
                        <label className="flex min-h-8 cursor-pointer items-center gap-3 rounded-sm text-[13px] text-slate-300 hover:text-white">
                            <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleOcrModel(model.key)}
                                className="h-4 w-4 shrink-0 cursor-pointer [color-scheme:dark] accent-sky-400 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400"
                            />
                            <span className="flex-1">{model.label}</span>
                            <span className="text-xs text-slate-400">
                                {model.runtime === 'tauri'
                                    ? 'Local'
                                    : model.runtime === 'onnx'
                                      ? 'Navigateur'
                                      : 'En ligne'}
                            </span>
                        </label>
                        {checked && action && (
                            <div className="ml-7 mt-1 flex flex-wrap items-center justify-between gap-2 pb-1">
                                {model.type === 'local' && (
                                    <span className="text-xs text-slate-500">
                                        {model.size}
                                    </span>
                                )}
                                {action}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
