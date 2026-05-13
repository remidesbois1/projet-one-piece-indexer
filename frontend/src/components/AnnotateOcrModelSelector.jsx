import React from 'react';
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, CloudLightning, Cpu, Download, RefreshCw, Sparkles, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { OCR_MODELS } from '@/context/WorkerContext';

function formatBytes(value) {
    if (!value) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let size = Number(value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export default function AnnotateOcrModelSelector({
    preferLocalOCR,
    toggleOcrPreference,
    activeModelKey,
    switchModel,
    modelStatus,
    loadModel,
    downloadProgress,
    geminiKey,
    isSandbox = false,
    isTauri = false,
    isCheckingLocalConnection = false,
    localModelStatus = null,
    localHealth = null,
    isDownloadingLocalModel = false,
    localDownloadState = null,
    localDownloadProgress = null,
    isLoadingLocalModel = false,
    localError = null,
    downloadLocalModel = () => { },
    loadLocalModel = () => { },
    refreshLocalDiagnostics = () => { },
    refreshLocalModelStatus = () => { }
}) {
    const localLoaded = Boolean(localModelStatus?.loaded || localHealth?.model_loaded);
    const downloadActive = Boolean(isDownloadingLocalModel || localDownloadState?.active || localModelStatus?.download?.active);
    const localDownloadPercent = Number.isFinite(localDownloadProgress)
        ? Math.round(localDownloadProgress)
        : null;
    const localStatusLabel = isCheckingLocalConnection
        ? "Connexion"
        : !isTauri
            ? "App desktop non detectee"
        : downloadActive
            ? `Telechargement${localDownloadPercent !== null ? ` ${localDownloadPercent}%` : ""}`
        : localModelStatus?.loading || isLoadingLocalModel
        ? "Chargement"
        : localModelStatus?.ready
            ? "Pret"
            : localLoaded
                ? "Charge"
            : localModelStatus?.installed
                ? "Installe, non charge"
                : "Modele absent";
    const localDevice = localHealth?.device || localModelStatus?.device;
    const boolLabel = (value) => value === true ? "Oui" : value === false ? "Non" : "-";
    const memoryLabel = localHealth?.gpu_memory_total_mb
        ? `${localHealth.gpu_memory_allocated_mb ?? 0}/${localHealth.gpu_memory_total_mb} MB`
        : "-";
    const downloadBytesLabel = localDownloadState?.total_bytes
        ? `${formatBytes(localDownloadState.downloaded_bytes)} / ${formatBytes(localDownloadState.total_bytes)}`
        : formatBytes(localDownloadState?.downloaded_bytes);
    const desktopStatusClass = isTauri && localHealth?.ok
        ? "bg-emerald-50 text-emerald-700 border-emerald-100"
        : isCheckingLocalConnection
            ? "bg-slate-50 text-slate-600 border-slate-200"
            : "bg-amber-50 text-amber-800 border-amber-200";
    const handleRefreshLocal = () => {
        const refresh = refreshLocalDiagnostics || refreshLocalModelStatus;
        return refresh();
    };

    return (
        <div className="flex-none p-3 rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col gap-3">
            <div className="flex items-center justify-between mb-1">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-0.5">Moteur OCR</h3>
                {!isSandbox && (
                    <button
                        onClick={toggleOcrPreference}
                        className={cn(
                            "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none",
                            preferLocalOCR ? "bg-emerald-500" : "bg-blue-500"
                        )}
                    >
                        <span className={cn(
                            "inline-block h-3 w-3 transform rounded-full bg-white transition-transform shadow-sm",
                            preferLocalOCR ? "translate-x-3.5" : "translate-x-0.5"
                        )} />
                    </button>
                )}
            </div>

            <div className="flex items-center gap-2.5 bg-slate-50 p-2 rounded-lg border border-slate-100/80">
                <div className={cn("p-1.5 rounded-md", (preferLocalOCR || isSandbox) ? "bg-emerald-100/50 text-emerald-600" : "bg-blue-100/50 text-blue-600")}>
                    {(preferLocalOCR || isSandbox) ? <Cpu size={14} /> : <CloudLightning size={14} />}
                </div>
                <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-slate-800 leading-tight">{(preferLocalOCR || isSandbox) ? "Mode Local" : "Cloud API"}</span>
                    <span className="text-[9px] font-bold text-slate-400 mt-0.5">{(preferLocalOCR || isSandbox) ? "Inférence locale" : "API Distante"}</span>
                </div>
            </div>

            {(
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-700">
                                {localModelStatus?.installed ? <CheckCircle2 size={12} className="text-emerald-600" /> : <Download size={12} className="text-slate-500" />}
                                <span>OCR local</span>
                            </div>
                            <p className="mt-0.5 text-[9px] font-semibold text-slate-400">
                                {localDevice ? `${localStatusLabel} - ${String(localDevice).toUpperCase()}` : localStatusLabel}
                            </p>
                        </div>
                        <div className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase", desktopStatusClass)}>
                            {isTauri && localHealth?.ok ? "Serveur OK" : isCheckingLocalConnection ? "Test" : "Hors ligne"}
                        </div>
                        <button
                            type="button"
                            onClick={handleRefreshLocal}
                            disabled={isCheckingLocalConnection}
                            className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 hover:text-slate-800 disabled:opacity-50"
                            title="Actualiser le statut local"
                        >
                            <RefreshCw size={12} className={cn(isCheckingLocalConnection && "animate-spin")} />
                        </button>
                    </div>

                    <div className="grid grid-cols-2 gap-1 text-[9px] font-semibold text-slate-500">
                        <div className="rounded-md bg-white px-2 py-1 border border-slate-100">
                            <span className="text-slate-400">Serveur</span>
                            <span className={cn("float-right font-bold", isTauri && localHealth?.ok ? "text-emerald-700" : "text-slate-700")}>{isTauri && localHealth?.ok ? "OK" : "Non"}</span>
                        </div>
                        <div className="rounded-md bg-white px-2 py-1 border border-slate-100">
                            <span className="text-slate-400">Torch</span>
                            <span className="float-right font-bold text-slate-700">{boolLabel(localHealth?.torch_available)}</span>
                        </div>
                        <div className="rounded-md bg-white px-2 py-1 border border-slate-100">
                            <span className="text-slate-400">CUDA</span>
                            <span className={cn("float-right font-bold", localHealth?.cuda_available ? "text-emerald-700" : "text-slate-700")}>{boolLabel(localHealth?.cuda_available)}</span>
                        </div>
                        <div className="rounded-md bg-white px-2 py-1 border border-slate-100">
                            <span className="text-slate-400">Modele</span>
                            <span className={cn("float-right font-bold", localLoaded ? "text-emerald-700" : "text-slate-700")}>{localLoaded ? "Charge" : "Non"}</span>
                        </div>
                        <div className="rounded-md bg-white px-2 py-1 border border-slate-100">
                            <span className="text-slate-400">VRAM</span>
                            <span className="float-right font-bold text-slate-700">{memoryLabel}</span>
                        </div>
                    </div>

                    {(downloadActive || localDownloadState?.downloaded_bytes || localDownloadState?.error) && (
                        <div className="rounded-md border border-slate-100 bg-white px-2 py-1.5">
                            <div className="mb-1 flex items-center justify-between text-[9px] font-bold text-slate-500">
                                <span>{downloadActive ? "Telechargement du modele" : "Telechargement"}</span>
                                <span>{localDownloadPercent !== null ? `${localDownloadPercent}%` : downloadBytesLabel}</span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                                <div
                                    className={cn("h-full rounded-full transition-all", localDownloadState?.error ? "bg-amber-500" : "bg-emerald-500", downloadProgress === null && downloadActive && "animate-pulse")}
                                    style={{ width: `${localDownloadPercent ?? (downloadActive ? 35 : 100)}%` }}
                                />
                            </div>
                            {localDownloadPercent !== null && (
                                <div className="mt-1 text-[8px] font-semibold text-slate-400">{downloadBytesLabel}</div>
                            )}
                        </div>
                    )}

                    {(localHealth?.gpu_name || localHealth?.torch_version || localHealth?.cuda_version || localModelStatus?.dtype) && (
                        <div className="space-y-0.5 rounded-md border border-slate-100 bg-white px-2 py-1.5 text-[9px] font-semibold leading-snug text-slate-500">
                            {localHealth?.gpu_name && <div className="truncate" title={localHealth.gpu_name}>GPU: <span className="font-bold text-slate-700">{localHealth.gpu_name}</span></div>}
                            {localHealth?.torch_version && <div>Torch: <span className="font-bold text-slate-700">{localHealth.torch_version}</span></div>}
                            {localHealth?.cuda_version && <div>CUDA build: <span className="font-bold text-slate-700">{localHealth.cuda_version}</span></div>}
                            {localModelStatus?.dtype && <div>Dtype: <span className="font-bold text-slate-700">{localModelStatus.dtype}</span></div>}
                        </div>
                    )}

                    {!localModelStatus?.installed && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={downloadLocalModel}
                            disabled={!isTauri || isDownloadingLocalModel || isCheckingLocalConnection}
                            className="w-full h-8 text-[10px] font-bold bg-white border-slate-200"
                        >
                            {downloadActive ? (
                                <span className="flex items-center gap-1.5">
                                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                                    Telechargement...
                                </span>
                            ) : (
                                <span className="flex items-center gap-1.5">
                                    <Download size={12} />
                                    Telecharger le modele local
                                </span>
                            )}
                        </Button>
                    )}

                    {localModelStatus?.installed && !localModelStatus?.ready && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={loadLocalModel}
                            disabled={!isTauri || isLoadingLocalModel || localModelStatus?.loading || isDownloadingLocalModel || isCheckingLocalConnection}
                            className="w-full h-8 text-[10px] font-bold bg-white border-slate-200"
                        >
                            {isLoadingLocalModel || localModelStatus?.loading ? (
                                <span className="flex items-center gap-1.5">
                                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                                    Chargement...
                                </span>
                            ) : (
                                <span className="flex items-center gap-1.5">
                                    <Cpu size={12} />
                                    Charger le modele local
                                </span>
                            )}
                        </Button>
                    )}

                    {localError && (
                        <div className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[9px] font-semibold leading-snug text-amber-800">
                            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                            <span>{localError}</span>
                        </div>
                    )}
                </div>
            )}

            <div className="flex flex-col gap-1.5">
                {Object.values(OCR_MODELS)
                    .filter(m => (preferLocalOCR || isSandbox) ? m.type === 'local' : m.type === 'api')
                    .map((m) => (
                        <button
                            key={m.key}
                            onClick={() => switchModel(m.key)}
                            disabled={preferLocalOCR && modelStatus === 'loading'}
                            className={cn(
                                "flex-1 p-2 rounded-lg border text-left transition-all duration-200",
                                activeModelKey === m.key
                                    ? (m.type === 'api' ? "border-indigo-300 bg-indigo-50/80 ring-1 ring-indigo-200/50" : "border-emerald-300 bg-emerald-50/80 ring-1 ring-emerald-200/50")
                                    : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
                                (preferLocalOCR && modelStatus === 'loading') && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            <div className="flex items-center justify-between mb-0.5">
                                <div className="flex items-center gap-1">
                                    {m.type === 'api' && <Sparkles size={10} className={cn(m.key === 'gemini' ? "text-blue-500" : "text-indigo-500")} />}
                                    <span className={cn(
                                        "text-[10px] font-bold",
                                        activeModelKey === m.key ? (m.type === 'api' ? (m.key === 'gemini' ? "text-blue-700" : "text-indigo-700") : "text-emerald-700") : "text-slate-600"
                                    )}>{m.label}</span>
                                </div>
                                {activeModelKey === m.key && (
                                    <div className={cn("w-1.5 h-1.5 rounded-full", m.type === 'api' ? (m.key === 'gemini' ? "bg-blue-500" : "bg-indigo-500") : "bg-emerald-500")} />
                                )}
                            </div>
                            <div className="text-[8px] font-semibold text-slate-400 leading-tight">
                                {m.key === 'gemini' ? "Vision AI · Google" : `CER ${m.cer} · ${m.size}`}
                            </div>
                        </button>
                    ))}
            </div>

            {preferLocalOCR || isSandbox ? (
                <div>
                    {OCR_MODELS[activeModelKey]?.type === 'local' ? (
                        <>
                            {(modelStatus === 'idle' || modelStatus === 'error') && (
                                <Button variant="outline" size="sm" onClick={() => loadModel(activeModelKey)} className="w-full h-8 text-[11px] font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-600">
                                    <Download size={12} className="mr-1.5" /> Charger {OCR_MODELS[activeModelKey]?.label}
                                </Button>
                            )}
                            {modelStatus === 'loading' && (
                                <div className="p-2 bg-slate-50 rounded-lg border border-slate-100">
                                    <div className="flex justify-between text-[9px] font-bold text-slate-500 mb-1.5">
                                        <span>Installation {OCR_MODELS[activeModelKey]?.label}...</span>
                                        <span>{Math.round(downloadProgress)}%</span>
                                    </div>
                                    <div className="h-1 w-full bg-slate-200 rounded-full overflow-hidden">
                                        <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${downloadProgress}%` }} />
                                    </div>
                                </div>
                            )}
                            {modelStatus === 'ready' && (
                                <div className="flex items-center justify-center gap-1.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 py-1.5 rounded-md border border-emerald-100/50">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm" /> {OCR_MODELS[activeModelKey]?.label} opérationnel
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="text-[10px] font-bold text-slate-400 text-center py-2 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                            Sélectionnez un modèle local
                        </div>
                    )}
                </div>
            ) : (
                <div>
                    {OCR_MODELS[activeModelKey]?.type === 'api' ? (
                        <>
                            {activeModelKey === 'poneglyph' && (
                                <div className="flex items-center justify-center gap-1.5 text-[10px] font-bold text-indigo-700 bg-indigo-50 py-1.5 rounded-md border border-indigo-100/50">
                                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-sm" /> Inférence Modal (Nvidia L4)
                                </div>
                            )}
                            {activeModelKey === 'gemini' && !geminiKey && (
                                <div className="animate-in fade-in slide-in-from-top-1 duration-300 flex flex-col gap-2 bg-amber-50 border border-amber-200/60 p-2.5 rounded-lg">
                                    <div className="flex items-start gap-2">
                                        <div className="bg-amber-100 p-1 rounded-full shrink-0 mt-0.5">
                                            <Shield className="h-3 w-3 text-amber-600" />
                                        </div>
                                        <div className="text-[10px] leading-tight text-amber-800">
                                            <span className="font-bold block mb-0.5">Clé API Requise</span>
                                            Google Gemini nécessite votre clé.
                                        </div>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => window.dispatchEvent(new Event('open-api-key-modal'))}
                                        className="h-7 text-[9px] font-bold bg-white"
                                    >
                                        Configurer ma clé
                                    </Button>
                                </div>
                            )}
                            {activeModelKey === 'gemini' && geminiKey && (
                                <div className="flex items-center justify-center gap-1.5 text-[10px] font-bold text-blue-700 bg-blue-50 py-1.5 rounded-md border border-blue-100/50">
                                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-sm" /> Gemini AI Connecté
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="text-[10px] font-bold text-slate-400 text-center py-2 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                            Sélectionnez un modèle Cloud
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
