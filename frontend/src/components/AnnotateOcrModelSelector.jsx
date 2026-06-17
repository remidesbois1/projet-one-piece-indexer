import React from 'react';
import { Button } from "@/components/ui/button";
import { CloudLightning, Cpu, Download, Sparkles, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { OCR_MODELS } from '@/context/WorkerContext';

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
    const activeModel = OCR_MODELS[activeModelKey];
    const activeIsTauriModel = activeModel?.runtime === 'tauri';
    const activeTauriModelKey = activeModel?.localModelKey || 'base';
    const activeLocalStatus = activeTauriModelKey === 'surya' ? localSuryaModelStatus : localTextModelStatus;
    const activeDownloadState = activeTauriModelKey === 'surya' ? localSuryaDownloadState : localTextDownloadState;
    const activeDownloadProgress = activeTauriModelKey === 'surya' ? localSuryaDownloadProgress : localTextDownloadProgress;
    const activeDownloadModel = activeTauriModelKey === 'surya' ? downloadLocalSuryaModel : downloadLocalTextModel;
    const activeLoadModel = activeTauriModelKey === 'surya' ? loadLocalSuryaModel : loadLocalTextModel;
    const activeDownloading = activeTauriModelKey === 'surya' ? isDownloadingLocalSuryaModel : isDownloadingLocalTextModel;
    const activeLoading = activeTauriModelKey === 'surya' ? isLoadingLocalSuryaModel : isLoadingLocalTextModel;
    const activeDownloadActive = Boolean(activeDownloading || activeDownloadState?.active);
    const activeDownloadPercent = Number.isFinite(activeDownloadProgress) ? Math.round(activeDownloadProgress) : null;
    const activeLocalLabel = activeModel?.label || "Modele local";
    const canDownloadTextModel = isTauri && activeIsTauriModel && !activeLocalStatus?.installed && !activeDownloadActive;
    const canLoadTextModel = isTauri && activeIsTauriModel && activeLocalStatus?.installed && !activeLocalStatus?.ready && !activeLoading && !activeDownloadActive;
    const isLocalMode = preferLocalOCR || isSandbox;
    const modeLabel = isLocalMode ? "Local" : "Modal";
    const modeDescription = isLocalMode ? "Inference locale" : "Inference distante";

    return (
        <div className="flex flex-none flex-col gap-3 rounded-xl border border-white/12 bg-white/[0.055] p-3 shadow-sm">
            <div className="flex items-center justify-between mb-1">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-0.5">Moteur OCR</h3>
                {!isSandbox && (
                    <button
                        onClick={toggleOcrPreference}
                        className={cn(
                            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors duration-200 focus:outline-none",
                            preferLocalOCR
                                ? "border-[#8dbbff]/35 bg-[#3d86ff]/24 shadow-[0_0_16px_rgba(61,134,255,0.18)]"
                                : "border-white/12 bg-white/[0.075]"
                        )}
                    >
                        <span className={cn(
                            "absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-white/20 bg-slate-100 shadow-sm transition-transform",
                            preferLocalOCR ? "translate-x-4" : "translate-x-0"
                        )} />
                    </button>
                )}
            </div>

            <div className="flex items-center gap-2.5 rounded-lg border border-white/12 bg-white/[0.06] p-2">
                <div className={cn(
                    "rounded-md border p-1.5",
                    isLocalMode
                        ? "border-[#8dbbff]/26 bg-[#3d86ff]/14 text-[#8dbbff]"
                        : "border-white/12 bg-white/[0.06] text-slate-300"
                )}>
                    {isLocalMode ? <Cpu size={14} /> : <CloudLightning size={14} />}
                </div>
                <div className="flex flex-col">
                    <span className="text-[11px] font-bold leading-tight text-slate-100">Mode {modeLabel}</span>
                    <span className="text-[9px] font-bold text-slate-400 mt-0.5">{modeDescription}</span>
                </div>
            </div>

            <div className="flex flex-col gap-1.5">
                {Object.values(OCR_MODELS)
                    .filter(m => (preferLocalOCR || isSandbox) ? m.type === 'local' : m.type === 'api')
                    .map((m) => {
                        const disabled = (preferLocalOCR && modelStatus === 'loading' && m.runtime !== 'tauri') || (m.runtime === 'tauri' && !isTauri);

                        return (
                        <button
                            key={m.key}
                            onClick={() => switchModel(m.key)}
                            disabled={disabled}
                            title={m.runtime === 'tauri' && !isTauri ? "Disponible dans l'app desktop" : m.description}
                            className={cn(
                                "flex-1 p-2 rounded-lg border text-left transition-all duration-200",
                                activeModelKey === m.key
                                    ? "border-[#8dbbff]/42 bg-[#3d86ff]/14 ring-1 ring-[#8dbbff]/18"
                                    : "border-white/12 bg-white/[0.055] hover:border-[#8dbbff]/38 hover:bg-white/[0.09]",
                                disabled && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            <div className="flex items-center justify-between mb-0.5">
                                <div className="flex items-center gap-1">
                                    {m.type === 'api' && <Sparkles size={10} className={cn(m.key === 'gemini' ? "text-blue-500" : "text-indigo-500")} />}
                                    <span className={cn(
                                        "text-[10px] font-bold",
                                        activeModelKey === m.key ? "text-[#bdd6ff]" : "text-slate-300"
                                    )}>{m.label}</span>
                                </div>
                                {activeModelKey === m.key && (
                                    <div className="h-1.5 w-1.5 rounded-full bg-[#8dbbff]" />
                                )}
                            </div>
                            <div className="text-[8px] font-semibold text-slate-400 leading-tight">
                                {m.key === 'gemini'
                                    ? "Vision AI · Google"
                                    : `${m.runtime === 'tauri' ? "Local" : m.type === 'api' ? "Modal" : "Navigateur"} · CER ${m.cer} · ${m.size}`}
                            </div>
                        </button>
                        );
                    })}
            </div>

            {preferLocalOCR || isSandbox ? (
                <div>
                    {activeIsTauriModel ? (
                        <>
                            {!isTauri && (
                                <div className="rounded-lg border border-dashed border-white/14 bg-white/[0.05] py-2 text-center text-[10px] font-bold text-slate-400">
                                    {activeLocalLabel} en local necessite l&apos;app desktop.
                                </div>
                            )}
                            {isTauri && canDownloadTextModel && (
                                <Button variant="outline" size="sm" onClick={activeDownloadModel} className="h-8 w-full border border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 hover:bg-white/12">
                                    <Download size={12} className="mr-1.5" /> Telecharger {activeLocalLabel}
                                </Button>
                            )}
                            {isTauri && canLoadTextModel && (
                                <Button variant="outline" size="sm" onClick={activeLoadModel} className="h-8 w-full border border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 hover:bg-white/12">
                                    <Download size={12} className="mr-1.5" /> Charger {activeLocalLabel}
                                </Button>
                            )}
                            {isTauri && (activeDownloadActive || activeLoading || activeLocalStatus?.loading) && (
                                <div className="rounded-lg border border-white/12 bg-white/[0.06] p-2">
                                    <div className="mb-1.5 flex justify-between text-[9px] font-bold text-slate-400">
                                        <span>{activeDownloadActive ? "Telechargement" : "Chargement"} {activeLocalLabel}...</span>
                                        {activeDownloadPercent !== null && <span>{activeDownloadPercent}%</span>}
                                    </div>
                                    <div className="h-1 w-full overflow-hidden rounded-full bg-white/12">
                                        <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${activeDownloadPercent ?? 40}%` }} />
                                    </div>
                                </div>
                            )}
                            {isTauri && activeLocalStatus?.ready && (
                                <div className="flex items-center justify-center gap-1.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 py-1.5 rounded-md border border-emerald-100/50">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm" /> {activeLocalLabel} operationnel
                                </div>
                            )}
                            {isTauri && activeLocalStatus?.error && !activeLocalStatus?.ready && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[9px] font-semibold text-amber-700">
                                    {activeLocalStatus.error}
                                </div>
                            )}
                        </>
                    ) : OCR_MODELS[activeModelKey]?.type === 'local' ? (
                        <>
                            {(modelStatus === 'idle' || modelStatus === 'error') && (
                                <Button variant="outline" size="sm" onClick={() => loadModel(activeModelKey)} className="h-8 w-full border border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 hover:bg-white/12">
                                    <Download size={12} className="mr-1.5" /> Charger {OCR_MODELS[activeModelKey]?.label}
                                </Button>
                            )}
                            {modelStatus === 'loading' && (
                                <div className="rounded-lg border border-white/12 bg-white/[0.06] p-2">
                                    <div className="mb-1.5 flex justify-between text-[9px] font-bold text-slate-400">
                                        <span>Installation {OCR_MODELS[activeModelKey]?.label}...</span>
                                        <span>{Math.round(downloadProgress)}%</span>
                                    </div>
                                    <div className="h-1 w-full overflow-hidden rounded-full bg-white/12">
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
                        <div className="rounded-lg border border-dashed border-white/14 bg-white/[0.05] py-2 text-center text-[10px] font-bold text-slate-400">
                            Sélectionnez un modèle local
                        </div>
                    )}
                </div>
            ) : (
                <div>
                    {OCR_MODELS[activeModelKey]?.type === 'api' ? (
                        <>
                            {activeModelKey === 'lighton' && (
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
                                        className="h-7 bg-white/[0.08] text-[9px] font-bold text-slate-100 hover:bg-white/12"
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
                        <div className="rounded-lg border border-dashed border-white/14 bg-white/[0.05] py-2 text-center text-[10px] font-bold text-slate-400">
                            Sélectionnez un modèle Cloud
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
