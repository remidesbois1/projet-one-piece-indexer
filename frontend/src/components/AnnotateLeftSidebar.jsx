import React from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    FileText,
    AlignLeft,
    MapPin,
    Users,
    Send,
    Settings2,
    Sparkles,
    Cpu,
    CloudLightning,
    Download
} from "lucide-react";
import AnnotateOcrModelSelector from './AnnotateOcrModelSelector';
import AnnotateBubbleScanner from './AnnotateBubbleScanner';
import { cn } from '@/lib/utils';
import { canDownloadMissingLocalModel } from './localModelRecovery';

const PAGE_STATUSES = [
    { value: 'not_started', label: 'Non commencée' },
    { value: 'in_progress', label: 'En cours' },
    { value: 'pending_review', label: 'En revue' },
    { value: 'completed', label: 'Validée' },
];

const PONEGLYPH_BBOX_LABEL = "Poneglyph-BBox";
const SURYA_BBOX_LABEL = "Surya-BBox";

export function formatPageStatus(status, isGuest = false) {
    if (typeof status === 'string' && status.trim()) {
        return status.replace(/_/g, ' ');
    }

    return isGuest ? 'lecture publique' : 'statut inconnu';
}

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
    selectedOcrModelKeys,
    toggleOcrModel,
    detectionStatus,
    loadDetectionModel,
    detectionProgress,
    downloadStats,
    handleExecuteDetection,
    isSubmitting,
    isAutoDetecting,
    queueLength,
    setShowDescModal,
    setShowApiKeyModal,
    handleSubmitPage,
    handlePageStatusChange,
    isUpdatingPageStatus,
    role,
    isSandbox = false,
    handleOneShot,
    isOneShotLoading,
    handleChatGptOneShot,
    isChatGptLoading = false,
    chatGptDesktopAvailable = false,
    handleOneShotPoneglyph,
    isPoneglyphLoading,
    poneglyphRunMode = null,
    handleOneShotLocalPoneglyph,
    handleOneShotLocalSuryaBbox,
    isTauri = false,
    localModelStatus = null,
    localTextModelStatus = null,
    localSuryaModelStatus = null,
    localSuryaBBoxModelStatus = null,
    isDownloadingLocalModel = false,
    isDownloadingLocalTextModel = false,
    isDownloadingLocalSuryaModel = false,
    isDownloadingLocalSuryaBBoxModel = false,
    localDownloadState = null,
    localTextDownloadState = null,
    localSuryaDownloadState = null,
    localSuryaBBoxDownloadState = null,
    localDownloadProgress = null,
    localTextDownloadProgress = null,
    localSuryaDownloadProgress = null,
    localSuryaBBoxDownloadProgress = null,
    localConnectionState = null,
    isLoadingLocalModel = false,
    isLoadingLocalTextModel = false,
    isLoadingLocalSuryaModel = false,
    isLoadingLocalSuryaBBoxModel = false,
    isLocalInferencing = false,
    isLocalSuryaBBoxInferencing = false,
    canRunLocalOcr = false,
    canRunLocalTextOcr = false,
    canRunLocalSuryaOcr = false,
    canRunLocalSuryaBBoxOcr = false,
    downloadLocalModel,
    downloadLocalTextModel,
    downloadLocalSuryaModel,
    downloadLocalSuryaBBoxModel,
    loadLocalModel,
    loadLocalTextModel,
    loadLocalSuryaModel,
    loadLocalSuryaBBoxModel
}) {
    const isStaff = role === 'Admin' || role === 'Modo';
    const isAdmin = role === 'Admin';
    const hasPageStatus = typeof page?.statut === 'string' && page.statut.length > 0;
    const canInlineEditStatus = isAdmin && hasPageStatus && handlePageStatusChange && !isSandbox;
    const isExtractionRunning = isOneShotLoading || isPoneglyphLoading || isLocalInferencing || isLocalSuryaBBoxInferencing;
    const localConnectionUnavailable = ['offline', 'reconnecting', 'unavailable'].includes(localConnectionState?.status);
    const localConnectionLabel = localConnectionState?.status === 'reconnecting'
        ? "Serveur local en reconnexion"
        : localConnectionState?.status === 'unavailable'
            ? "Serveur local indisponible"
            : "Serveur local hors ligne";
    const localDisabledReason = !isTauri
        ? "App desktop non detectee"
        : localConnectionUnavailable
            ? localConnectionLabel
        : isDownloadingLocalModel || localDownloadState?.active
            ? `Telechargement du modele ${PONEGLYPH_BBOX_LABEL}`
            : !localModelStatus?.installed
                ? `Modele ${PONEGLYPH_BBOX_LABEL} non telecharge`
                : !localModelStatus?.ready
                    ? `Modele ${PONEGLYPH_BBOX_LABEL} non charge`
                    : null;
    const suryaBBoxDownloadActive = Boolean(isDownloadingLocalSuryaBBoxModel || localSuryaBBoxDownloadState?.active);
    const suryaBBoxDownloadPercent = Number.isFinite(localSuryaBBoxDownloadProgress) ? Math.round(localSuryaBBoxDownloadProgress) : null;
    const suryaBBoxDisabledReason = !isTauri
        ? "App desktop non detectee"
        : localConnectionUnavailable
            ? localConnectionLabel
            : suryaBBoxDownloadActive
                ? `Telechargement du modele ${SURYA_BBOX_LABEL}`
                : localSuryaBBoxModelStatus?.error
                    ? localSuryaBBoxModelStatus.error
                : !localSuryaBBoxModelStatus?.installed
                    ? `Modele ${SURYA_BBOX_LABEL} non telecharge`
                    : !localSuryaBBoxModelStatus?.ready
                        ? `Modele ${SURYA_BBOX_LABEL} non charge`
                        : null;
    const poneglyphDownloadActive = Boolean(isDownloadingLocalModel || localDownloadState?.active);
    const poneglyphDownloadPercent = Number.isFinite(localDownloadProgress) ? Math.round(localDownloadProgress) : null;
    const poneglyphIsLoading = Boolean(isLoadingLocalModel || localModelStatus?.loading);
    const canDownloadPoneglyph = isTauri
        && handleOneShotLocalPoneglyph
        && canDownloadMissingLocalModel(localModelStatus, poneglyphDownloadActive);
    const canLoadPoneglyph = isTauri && handleOneShotLocalPoneglyph && localModelStatus?.installed && !localModelStatus?.ready && !poneglyphIsLoading && !poneglyphDownloadActive && !localModelStatus?.error;
    const poneglyphAction = canRunLocalOcr ? 'run' : canLoadPoneglyph ? 'load' : canDownloadPoneglyph ? 'download' : null;

    const suryaBBoxIsLoading = Boolean(isLoadingLocalSuryaBBoxModel || localSuryaBBoxModelStatus?.loading);
    const canDownloadSuryaBBox = isTauri
        && handleOneShotLocalSuryaBbox
        && canDownloadMissingLocalModel(localSuryaBBoxModelStatus, suryaBBoxDownloadActive);
    const canLoadSuryaBBox = isTauri && handleOneShotLocalSuryaBbox && !localSuryaBBoxModelStatus?.error && localSuryaBBoxModelStatus?.installed && !localSuryaBBoxModelStatus?.ready && !suryaBBoxIsLoading && !suryaBBoxDownloadActive;
    const suryaBBoxAction = canRunLocalSuryaBBoxOcr ? 'run' : canLoadSuryaBBox ? 'load' : canDownloadSuryaBBox ? 'download' : null;

    return (
        <div className="relative z-40 hidden h-full w-[280px] shrink-0 flex-col border-r border-white/10 bg-[#06111e] text-slate-100 shadow-sm lg:flex">
            <div className="z-10 flex-none space-y-3 border-b border-white/10 p-4">
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
                            <h2 className="text-xl font-black tracking-tight text-white">
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
                    {canInlineEditStatus ? (
                        <Select value={page.statut} onValueChange={handlePageStatusChange} disabled={isUpdatingPageStatus}>
                            <SelectTrigger
                                aria-label="Etat de la page"
                                className="h-7 w-[130px] rounded-full border-white/12 bg-white/[0.07] px-2 text-[10px] font-bold uppercase tracking-wide text-slate-200"
                            >
                                <SelectValue placeholder="Etat" />
                            </SelectTrigger>
                            <SelectContent>
                                {PAGE_STATUSES.map(status => (
                                    <SelectItem key={status.value} value={status.value}>
                                        {status.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    ) : (
                        <Badge variant="secondary" className="border border-white/12 bg-white/[0.07] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-200">
                            {formatPageStatus(page?.statut, isGuest)}
                        </Badge>
                    )}
                </div>

                {!isGuest && !isSandbox && (
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={!navContext.prev}
                            onClick={goToPrev}
                            className="h-8 flex-1 rounded-md border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 shadow-none hover:bg-white/12"
                        >
                            <ChevronLeft size={14} className="mr-1" /> Préc
                        </Button>
                        <div className="min-w-0 flex-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-400">
                            {chapterPages.length > 0 ? `Page ${page.numero_page}/${chapterPages.length}` : "Page test"}
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={!navContext.next}
                            onClick={goToNext}
                            className="h-8 flex-1 rounded-md border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 shadow-none hover:bg-white/12"
                        >
                            Suiv <ChevronRight size={14} className="ml-1" />
                        </Button>
                    </div>
                )}
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-y-auto bg-[#030a13]/38 p-4">
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
                            selectedOcrModelKeys={selectedOcrModelKeys}
                            toggleOcrModel={toggleOcrModel}
                            isSandbox={isSandbox}
                            isTauri={isTauri}
                            localTextModelStatus={localTextModelStatus}
                            localSuryaModelStatus={localSuryaModelStatus}
                            isDownloadingLocalTextModel={isDownloadingLocalTextModel}
                            isDownloadingLocalSuryaModel={isDownloadingLocalSuryaModel}
                            localTextDownloadState={localTextDownloadState}
                            localSuryaDownloadState={localSuryaDownloadState}
                            localTextDownloadProgress={localTextDownloadProgress}
                            localSuryaDownloadProgress={localSuryaDownloadProgress}
                            isLoadingLocalTextModel={isLoadingLocalTextModel}
                            isLoadingLocalSuryaModel={isLoadingLocalSuryaModel}
                            canRunLocalTextOcr={canRunLocalTextOcr}
                            canRunLocalSuryaOcr={canRunLocalSuryaOcr}
                            downloadLocalTextModel={downloadLocalTextModel}
                            downloadLocalSuryaModel={downloadLocalSuryaModel}
                            loadLocalTextModel={loadLocalTextModel}
                            loadLocalSuryaModel={loadLocalSuryaModel}
                        />

                        <AnnotateBubbleScanner
                            detectionStatus={detectionStatus}
                            loadDetectionModel={loadDetectionModel}
                            detectionProgress={detectionProgress}
                            downloadStats={downloadStats}
                            handleExecuteDetection={handleExecuteDetection}
                            isSubmitting={isSubmitting}
                            isAutoDetecting={isAutoDetecting}
                            queueLength={queueLength}
                        />

                        {role === 'Admin' && (handleOneShot || handleChatGptOneShot || handleOneShotPoneglyph || handleOneShotLocalPoneglyph || handleOneShotLocalSuryaBbox) && (
                            <div className="flex-none rounded-lg border border-white/12 bg-white/[0.055] p-3 shadow-sm">
                                <div className="mb-3 flex items-center justify-between gap-2">
                                    <h3 className="truncate text-[10px] font-black uppercase tracking-widest text-slate-500">
                                        Extraction intégrale
                                    </h3>
                                    <span className="rounded-full border border-white/12 bg-white/[0.07] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                                        {isExtractionRunning ? "En cours" : "Prêt"}
                                    </span>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
                                        <Cpu size={10} /> Local
                                    </div>
                                    {handleOneShotLocalPoneglyph && (
                                        <Button
                                            onClick={
                                                poneglyphAction === 'run' ? handleOneShotLocalPoneglyph
                                                : poneglyphAction === 'load' ? loadLocalModel
                                                : poneglyphAction === 'download' ? downloadLocalModel
                                                : undefined
                                            }
                                            disabled={!poneglyphAction || isPoneglyphLoading || isLocalInferencing || isSubmitting || isAutoDetecting}
                                            title={
                                                poneglyphAction === 'load' ? `Charger ${PONEGLYPH_BBOX_LABEL} en VRAM`
                                                : poneglyphAction === 'download' ? `Telecharger ${PONEGLYPH_BBOX_LABEL}`
                                                : localDisabledReason || `Lancer ${PONEGLYPH_BBOX_LABEL} en local`
                                            }
                                            className={cn(
                                                "h-9 w-full justify-start gap-2 rounded-md px-3 text-[11px] font-bold uppercase tracking-wide shadow-none",
                                                poneglyphAction === 'run'
                                                    ? "bg-slate-900 text-white hover:bg-slate-800"
                                                    : poneglyphAction
                                                        ? "border border-white/12 bg-white/[0.08] text-slate-200 hover:bg-white/12"
                                                        : "border border-white/10 bg-white/[0.045] text-slate-500"
                                            )}
                                        >
                                            {poneglyphAction === 'download' ? <Download size={14} /> : <Cpu size={14} />}
                                            <span className="min-w-0 flex-1 truncate text-left">
                                                {poneglyphRunMode === 'local' || isLocalInferencing
                                                    ? `${PONEGLYPH_BBOX_LABEL} - Local...`
                                                    : poneglyphAction === 'load'
                                                        ? poneglyphIsLoading ? `Chargement ${PONEGLYPH_BBOX_LABEL}...` : `Charger ${PONEGLYPH_BBOX_LABEL}`
                                                        : poneglyphAction === 'download'
                                                            ? poneglyphDownloadActive ? `Telechargement ${PONEGLYPH_BBOX_LABEL}...` : `Telecharger ${PONEGLYPH_BBOX_LABEL}`
                                                            : `${PONEGLYPH_BBOX_LABEL} - Local`}
                                            </span>
                                            {(poneglyphRunMode === 'local' || isLocalInferencing || poneglyphIsLoading) && (
                                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                            )}
                                        </Button>
                                    )}

                                    {handleOneShotLocalPoneglyph && (poneglyphDownloadActive || poneglyphIsLoading) && (
                                        <div className="rounded-md border border-white/12 bg-white/[0.06] px-2 py-1.5">
                                            <div className="mb-1 flex justify-between text-[9px] font-bold text-slate-400">
                                                <span>{poneglyphDownloadActive ? "Telechargement" : "Chargement"} {PONEGLYPH_BBOX_LABEL}...</span>
                                                {poneglyphDownloadPercent !== null && <span>{poneglyphDownloadPercent}%</span>}
                                            </div>
                                            <div className="h-1 w-full overflow-hidden rounded-full bg-white/12">
                                                <div className="h-full bg-slate-500 transition-all duration-300" style={{ width: `${poneglyphDownloadPercent ?? 40}%` }} />
                                            </div>
                                        </div>
                                    )}

                                    {handleOneShotLocalSuryaBbox && (
                                        <Button
                                            onClick={
                                                suryaBBoxAction === 'run' ? handleOneShotLocalSuryaBbox
                                                : suryaBBoxAction === 'load' ? loadLocalSuryaBBoxModel
                                                : suryaBBoxAction === 'download' ? downloadLocalSuryaBBoxModel
                                                : undefined
                                            }
                                            disabled={!suryaBBoxAction || isPoneglyphLoading || isLocalSuryaBBoxInferencing || isSubmitting || isAutoDetecting}
                                            title={
                                                suryaBBoxAction === 'load' ? `Charger ${SURYA_BBOX_LABEL} en VRAM`
                                                : suryaBBoxAction === 'download' ? `Telecharger ${SURYA_BBOX_LABEL}`
                                                : suryaBBoxDisabledReason || `Lancer ${SURYA_BBOX_LABEL} en local`
                                            }
                                            className={cn(
                                                "h-9 w-full justify-start gap-2 rounded-md px-3 text-[11px] font-bold uppercase tracking-wide shadow-none",
                                                suryaBBoxAction === 'run'
                                                    ? "bg-emerald-700 text-white hover:bg-emerald-800"
                                                    : suryaBBoxAction
                                                        ? "border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                                                        : "border border-white/10 bg-white/[0.045] text-slate-500"
                                            )}
                                        >
                                            {suryaBBoxAction === 'download' ? <Download size={14} /> : <Cpu size={14} />}
                                            <span className="min-w-0 flex-1 truncate text-left">
                                                {poneglyphRunMode === 'surya-bbox-local' || isLocalSuryaBBoxInferencing
                                                    ? `${SURYA_BBOX_LABEL} - Local...`
                                                    : suryaBBoxAction === 'load'
                                                        ? suryaBBoxIsLoading ? `Chargement ${SURYA_BBOX_LABEL}...` : `Charger ${SURYA_BBOX_LABEL}`
                                                        : suryaBBoxAction === 'download'
                                                            ? suryaBBoxDownloadActive ? `Telechargement ${SURYA_BBOX_LABEL}...` : `Telecharger ${SURYA_BBOX_LABEL}`
                                                            : `${SURYA_BBOX_LABEL} - Local`}
                                            </span>
                                            {(poneglyphRunMode === 'surya-bbox-local' || isLocalSuryaBBoxInferencing || suryaBBoxIsLoading) && (
                                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                            )}
                                        </Button>
                                    )}

                                    {handleOneShotLocalSuryaBbox && (suryaBBoxDownloadActive || suryaBBoxIsLoading) && (
                                        <div className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5">
                                            <div className="mb-1 flex justify-between text-[9px] font-bold text-emerald-800">
                                                <span>{suryaBBoxDownloadActive ? "Telechargement" : "Chargement"} {SURYA_BBOX_LABEL}...</span>
                                                {suryaBBoxDownloadPercent !== null && <span>{suryaBBoxDownloadPercent}%</span>}
                                            </div>
                                            <div className="h-1 w-full overflow-hidden rounded-full bg-emerald-100">
                                                <div className="h-full bg-emerald-600 transition-all duration-300" style={{ width: `${suryaBBoxDownloadPercent ?? 40}%` }} />
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-2 border-t border-white/10 pt-2">
                                    <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
                                        <CloudLightning size={10} /> En ligne
                                    </div>

                                    {handleOneShotPoneglyph && (
                                        <Button
                                            variant="outline"
                                            onClick={handleOneShotPoneglyph}
                                            disabled={isPoneglyphLoading || isSubmitting || isAutoDetecting}
                                            className="h-9 w-full justify-start gap-2 rounded-md border-white/12 bg-white/[0.07] px-3 text-[11px] font-bold uppercase tracking-wide text-slate-200 shadow-none hover:bg-white/12"
                                        >
                                            <CloudLightning size={14} className="text-slate-500" />
                                            <span className="min-w-0 flex-1 truncate text-left">
                                                {poneglyphRunMode === 'modal' ? `${PONEGLYPH_BBOX_LABEL} - Modal...` : `${PONEGLYPH_BBOX_LABEL} - Modal`}
                                            </span>
                                            {poneglyphRunMode === 'modal' && (
                                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                            )}
                                        </Button>
                                    )}

                                    {handleOneShot && (
                                        <Button
                                            variant="outline"
                                            onClick={handleOneShot}
                                            disabled={isOneShotLoading || isSubmitting || isAutoDetecting}
                                            className="h-9 w-full justify-start gap-2 rounded-md border-white/12 bg-white/[0.07] px-3 text-[11px] font-bold uppercase tracking-wide text-slate-200 shadow-none hover:bg-white/12"
                                        >
                                            <Sparkles size={14} className="text-slate-500" />
                                            <span className="min-w-0 flex-1 truncate text-left">
                                                {isOneShotLoading ? "Gemini..." : "Gemini"}
                                            </span>
                                            {isOneShotLoading && (
                                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                            )}
                                        </Button>
                                    )}

                                    {chatGptDesktopAvailable && handleChatGptOneShot && (
                                        <Button
                                            variant="outline"
                                            onClick={handleChatGptOneShot}
                                            disabled={isChatGptLoading || isSubmitting || isAutoDetecting}
                                            className="h-9 w-full justify-start gap-2 rounded-md border-white/12 bg-white/[0.07] px-3 text-[11px] font-bold uppercase tracking-wide text-slate-200 shadow-none hover:bg-white/12"
                                        >
                                            <Sparkles size={14} className="text-sky-400" />
                                            <span className="min-w-0 flex-1 truncate text-left">
                                                {isChatGptLoading ? "GPT-5.6 Luna..." : "GPT-5.6 Luna"}
                                            </span>
                                            {isChatGptLoading && (
                                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                            )}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}

                {role === 'User' && !isSandbox && (
                    <div className="flex max-h-[500px] flex-none flex-col gap-5 overflow-y-auto rounded-xl border border-white/12 bg-white/[0.055] p-4 shadow-sm">
                        <div className="flex items-center gap-2 pb-2 border-b border-slate-50">
                            <div className="bg-indigo-50 p-1.5 rounded-lg border border-indigo-100/50">
                                <FileText size={14} className="text-indigo-600" />
                            </div>
                            <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-100">Métadonnées Page</h3>
                        </div>

                        <div className="space-y-5">
                            <div className="space-y-2">
                                <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-tight">
                                    <AlignLeft size={10} /> Description Sémantique
                                </div>
                                <div className="rounded-lg border border-white/12 bg-white/[0.06] p-3 text-[11px] leading-relaxed text-slate-300 italic">
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
                                                <Badge key={idx} variant="secondary" className="border border-white/12 bg-white/[0.07] px-2 py-0.5 text-[10px] font-medium text-slate-200">
                                                    {char}
                                                </Badge>
                                            ))
                                        ) : (
                                            <span className="rounded bg-white/[0.06] px-2 py-1 text-[10px] text-slate-400 italic">Aucun personnage listé</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {!isGuest && isStaff && !isSandbox && (
                <div className="z-10 flex flex-none flex-col gap-2.5 border-t border-white/10 bg-[#06111e] p-4">
                    <div className="grid grid-cols-2 gap-2">
                        <Button variant="outline" size="sm" className="h-8 w-full border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 hover:bg-white/12 hover:text-white" onClick={() => setShowDescModal(true)}>
                            <FileText size={12} className="mr-1.5" /> Meta
                        </Button>
                        <Button variant="outline" size="sm" className="h-8 w-full border-white/12 bg-white/[0.07] text-[11px] font-bold text-slate-200 hover:bg-white/12 hover:text-white" onClick={() => setShowApiKeyModal(true)}>
                            <Settings2 size={12} className="mr-1.5" /> Clé API
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
