import React from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    FileText,
    AlignLeft,
    MapPin,
    Users,
    Send,
    Settings2
} from "lucide-react";
import AnnotateOcrModelSelector from './AnnotateOcrModelSelector';
import AnnotateBubbleScanner from './AnnotateBubbleScanner';

export default function AnnotateLeftSidebar({
    fromSearch,
    mangaSlug,
    page,
    chapterPages,
    navContext,
    goToPrev,
    goToNext,
    isGuest,
    preferLocalOCR,
    toggleOcrPreference,
    activeModelKey,
    switchModel,
    modelStatus,
    loadModel,
    downloadProgress,
    geminiKey,
    detectionStatus,
    loadDetectionModel,
    detectionProgress,
    handleExecuteDetection,
    isSubmitting,
    isAutoDetecting,
    queueLength,
    setShowDescModal,
    setShowApiKeyModal,
    handleSubmitPage,
    role,
    isSandbox = false,
    handleOneShot,
    isOneShotLoading
}) {
    const isStaff = role === 'Admin' || role === 'Modo';

    return (
        <div className="hidden lg:flex w-[280px] shrink-0 h-full flex-col border-r border-slate-200 bg-white z-40 relative shadow-sm">
            <div className="p-4 border-b border-slate-100 flex-none space-y-4 z-10">
                <Link
                    href={!mangaSlug ? "/" : (fromSearch ? `/${mangaSlug}/search` : `/${mangaSlug}/dashboard`)}
                    className="inline-flex items-center text-[11px] font-bold text-slate-400 hover:text-slate-700 uppercase tracking-wider transition-colors"
                >
                    <ArrowLeft size={12} className="mr-2" />
                    {!mangaSlug ? "Retour Accueil" : (fromSearch ? "Retour Recherche" : "Retour Dashboard")}
                </Link>

                <div className="flex items-center justify-between">
                    <div>
                        <div className="flex items-baseline gap-1.5">
                            <h2 className="text-xl font-black text-slate-900 tracking-tight">
                                {page.chapitres ? `Ch.${page.chapitres.numero}` : "Mode Local"}
                            </h2>
                            {page.chapitres?.tomes && (
                                <span className="text-xs font-bold text-slate-400">Vol.{page.chapitres.tomes.numero}</span>
                            )}
                        </div>
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mt-0.5">
                            {chapterPages.length > 0 ? `Page ${page.numero_page} sur ${chapterPages.length}` : "Page de test"}
                        </div>
                    </div>
                    <Badge variant="secondary" className="bg-slate-50 text-slate-600 border border-slate-200/60 font-bold px-2 py-0.5 text-[10px] uppercase tracking-wide">
                        {page.statut.replace(/_/g, ' ')}
                    </Badge>
                </div>
            </div>

            <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden bg-slate-50/50">
                {!isGuest && !isSandbox && (
                    <div className="flex-none p-3 rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col gap-2">
                        <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-0.5">Navigation</h3>
                        <div className="flex gap-2">
                            <Button variant="outline" size="sm" disabled={!navContext.prev} onClick={goToPrev} className="flex-1 h-8 text-[11px] font-bold bg-white border-slate-200 hover:bg-slate-50 text-slate-600">
                                <ChevronLeft size={14} className="mr-1" /> Préc
                            </Button>
                            <Button variant="outline" size="sm" disabled={!navContext.next} onClick={goToNext} className="flex-1 h-8 text-[11px] font-bold bg-white border-slate-200 hover:bg-slate-50 text-slate-600">
                                Suiv <ChevronRight size={14} className="ml-1" />
                            </Button>
                        </div>
                    </div>
                )}

                {!isGuest && isStaff && (
                    <>
                        <AnnotateOcrModelSelector
                            preferLocalOCR={preferLocalOCR}
                            toggleOcrPreference={toggleOcrPreference}
                            activeModelKey={activeModelKey}
                            switchModel={switchModel}
                            modelStatus={modelStatus}
                            loadModel={loadModel}
                            downloadProgress={downloadProgress}
                            geminiKey={geminiKey}
                            isSandbox={isSandbox}
                        />

                        <AnnotateBubbleScanner
                            detectionStatus={detectionStatus}
                            loadDetectionModel={loadDetectionModel}
                            detectionProgress={detectionProgress}
                            handleExecuteDetection={handleExecuteDetection}
                            isSubmitting={isSubmitting}
                            isAutoDetecting={isAutoDetecting}
                            queueLength={queueLength}
                        />

                        {role === 'Admin' && handleOneShot && (
                            <div className="flex-none p-4 rounded-xl border border-indigo-200/60 bg-indigo-50/30 shadow-sm flex flex-col gap-3">
                                <h3 className="text-[10px] font-bold text-indigo-700 uppercase tracking-widest pl-0.5">Extraction Intégrale</h3>
                                <Button 
                                    onClick={handleOneShot} 
                                    disabled={isOneShotLoading || isSubmitting || isAutoDetecting}
                                    className="w-full h-10 bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] uppercase tracking-wider font-bold shadow-md"
                                >
                                    {isOneShotLoading ? (
                                        <span className="flex items-center gap-2">
                                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                            Analyse en cours...
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-2">
                                            <FileText size={14} />
                                            One-Shot
                                        </span>
                                    )}
                                </Button>
                            </div>
                        )}
                    </>
                )}

                {role === 'User' && !isSandbox && (
                    <div className="flex-none p-4 rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col gap-5 overflow-y-auto max-h-[500px]">
                        <div className="flex items-center gap-2 pb-2 border-b border-slate-50">
                            <div className="bg-indigo-50 p-1.5 rounded-lg border border-indigo-100/50">
                                <FileText size={14} className="text-indigo-600" />
                            </div>
                            <h3 className="text-[11px] font-bold text-slate-900 uppercase tracking-widest">Métadonnées Page</h3>
                        </div>

                        <div className="space-y-5">
                            <div className="space-y-2">
                                <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-tight">
                                    <AlignLeft size={10} /> Description Sémantique
                                </div>
                                <div className="text-[11px] text-slate-600 leading-relaxed bg-slate-50/50 p-3 rounded-lg border border-slate-100/60 italic">
                                    {page.description_semantique?.content || "Aucune description rattachée à cette page."}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-tight">
                                        <MapPin size={10} /> Arc Narratif
                                    </div>
                                    <div className="flex">
                                        <Badge variant="outline" className="text-[10px] font-bold text-indigo-700 bg-indigo-50/30 border-indigo-100 px-2 py-0.5">
                                            {page.description_semantique?.arc || "Inconnu"}
                                        </Badge>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-tight">
                                        <Users size={10} /> Personnages
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {page.description_semantique?.characters?.length > 0 ? (
                                            page.description_semantique.characters.map((char, idx) => (
                                                <Badge key={idx} variant="secondary" className="text-[10px] font-medium bg-white border border-slate-100 text-slate-600 px-2 py-0.5">
                                                    {char}
                                                </Badge>
                                            ))
                                        ) : (
                                            <span className="text-[10px] text-slate-400 italic bg-slate-50 px-2 py-1 rounded">Aucun personnage listé</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {!isGuest && isStaff && !isSandbox && (
                <div className="flex-none p-4 border-t border-slate-100 bg-white flex flex-col gap-2.5 z-10">
                    <div className="grid grid-cols-2 gap-2">
                        <Button variant="outline" size="sm" className="h-8 text-[11px] font-bold text-slate-600 bg-slate-50 border-slate-200/60 hover:bg-slate-100 hover:text-slate-900 w-full" onClick={() => setShowDescModal(true)}>
                            <FileText size={12} className="mr-1.5" /> Meta
                        </Button>
                        <Button variant="outline" size="sm" className="h-8 text-[11px] font-bold text-slate-600 bg-slate-50 border-slate-200/60 hover:bg-slate-100 hover:text-slate-900 w-full" onClick={() => setShowApiKeyModal(true)}>
                            <Settings2 size={12} className="mr-1.5" /> Clés API
                        </Button>
                    </div>

                    <Button
                        variant="default"
                        className="w-full h-10 bg-slate-900 hover:bg-slate-800 text-white text-[11px] uppercase tracking-wider font-bold shadow-md"
                        disabled={page.statut === 'pending_review' || page.statut === 'completed'}
                        onClick={handleSubmitPage}
                    >
                        <Send size={12} className="mr-1.5" /> Validation Finale
                    </Button>
                </div>
            )}
        </div>
    );
}
