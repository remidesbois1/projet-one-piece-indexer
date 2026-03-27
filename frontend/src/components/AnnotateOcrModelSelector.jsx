import React from 'react';
import { Button } from "@/components/ui/button";
import { Cpu, CloudLightning, Download, Sparkles, Shield, RotateCcw } from "lucide-react";
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
    isSandbox = false
}) {
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
                                {m.key === 'poneglyph' ? `CER ${m.cer} - Serverless` : m.key === 'gemini' ? "Vision AI · Google" : `CER ${m.cer} · ${m.size}`}
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
