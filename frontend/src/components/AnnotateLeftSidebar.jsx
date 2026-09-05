import React, { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    FileText,
    Settings2,
    ScanText,
    Download,
    Loader2,
} from 'lucide-react';
import AnnotateOcrModelSelector from './AnnotateOcrModelSelector';
import AnnotateBubbleScanner from './AnnotateBubbleScanner';
import { canDownloadMissingLocalModel } from './localModelRecovery';

const PAGE_STATUSES = [
    { value: 'not_started', label: 'Non commencée' },
    { value: 'in_progress', label: 'En cours' },
    { value: 'pending_review', label: 'En revue' },
    { value: 'completed', label: 'Validée' },
];

export function formatPageStatus(status, isGuest = false) {
    return (
        PAGE_STATUSES.find((item) => item.value === status)?.label ||
        (typeof status === 'string' && status.trim()
            ? status.replace(/_/g, ' ')
            : isGuest
              ? 'lecture publique'
              : 'Statut inconnu')
    );
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
    geminiFullPageModel = 'gemini-2.5-flash-lite',
    handleChatGptOneShot,
    isChatGptLoading = false,
    chatGptDesktopAvailable = false,
    chatGptFullPageModel = 'gpt-5.6-luna',
    handleOneShotPoneglyph,
    isPoneglyphLoading,
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
    loadLocalSuryaBBoxModel,
}) {
    const [selectedEngine, setSelectedEngine] = useState('');
    const isStaff = role === 'Admin' || role === 'Modo';
    const canInlineEditStatus =
        role === 'Admin' &&
        page?.statut &&
        handlePageStatusChange &&
        !isSandbox;
    const connectionUnavailable = [
        'offline',
        'reconnecting',
        'unavailable',
    ].includes(localConnectionState?.status);
    const busy = Boolean(
        isSubmitting ||
            isAutoDetecting ||
            isOneShotLoading ||
            isChatGptLoading ||
            isPoneglyphLoading ||
            isLocalInferencing ||
            isLocalSuryaBBoxInferencing
    );

    const localEngine = ({
        key,
        label,
        handler,
        status,
        downloading,
        downloadState,
        progress,
        loading,
        canRun,
        download,
        load,
    }) => {
        const isDownloading = Boolean(downloading || downloadState?.active);
        const isLoading = Boolean(loading || status?.loading);
        const action = canRun
            ? 'run'
            : canDownloadMissingLocalModel(status, isDownloading)
              ? 'download'
              : status?.installed && !status.ready && !status.error
                ? 'load'
                : null;
        return {
            key,
            label,
            available: isTauri && Boolean(handler),
            action,
            handler:
                action === 'run'
                    ? handler
                    : action === 'download'
                      ? download
                      : load,
            preparing: isDownloading || isLoading,
            progress:
                isDownloading && Number.isFinite(progress)
                    ? Math.max(0, Math.min(100, Math.round(progress)))
                    : null,
            message: isDownloading
                ? 'Téléchargement du modèle…'
                : isLoading
                  ? 'Chargement du modèle…'
                  : connectionUnavailable
                    ? localConnectionState?.status === 'reconnecting'
                        ? 'Reconnexion au serveur local…'
                        : 'Serveur local indisponible.'
                    : status?.error ||
                      (!action ? 'Modèle indisponible.' : null),
            disabled:
                connectionUnavailable || isDownloading || isLoading || !action,
        };
    };
    const engines = [
        localEngine({
            key: 'poneglyph-local',
            label: 'Poneglyph-BBox · local',
            handler: handleOneShotLocalPoneglyph,
            status: localModelStatus,
            downloading: isDownloadingLocalModel,
            downloadState: localDownloadState,
            progress: localDownloadProgress,
            loading: isLoadingLocalModel,
            canRun: canRunLocalOcr,
            download: downloadLocalModel,
            load: loadLocalModel,
        }),
        localEngine({
            key: 'surya-local',
            label: 'Surya-BBox · local',
            handler: handleOneShotLocalSuryaBbox,
            status: localSuryaBBoxModelStatus,
            downloading: isDownloadingLocalSuryaBBoxModel,
            downloadState: localSuryaBBoxDownloadState,
            progress: localSuryaBBoxDownloadProgress,
            loading: isLoadingLocalSuryaBBoxModel,
            canRun: canRunLocalSuryaBBoxOcr,
            download: downloadLocalSuryaBBoxModel,
            load: loadLocalSuryaBBoxModel,
        }),
        {
            key: 'poneglyph',
            label: 'Poneglyph-BBox · en ligne',
            available: Boolean(handleOneShotPoneglyph),
            handler: handleOneShotPoneglyph,
        },
        {
            key: 'gemini',
            label: 'Gemini',
            model: geminiFullPageModel,
            available: Boolean(handleOneShot),
            handler: handleOneShot,
        },
        {
            key: 'chatgpt',
            label: 'ChatGPT',
            model: chatGptFullPageModel,
            available: chatGptDesktopAvailable && Boolean(handleChatGptOneShot),
            handler: handleChatGptOneShot,
        },
    ].filter((engine) => engine.available);
    const engine =
        engines.find((item) => item.key === selectedEngine) || engines[0];
    const running =
        isOneShotLoading ||
        isChatGptLoading ||
        isPoneglyphLoading ||
        isLocalInferencing ||
        isLocalSuryaBBoxInferencing;
    const actionLabel = running
        ? 'Lecture en cours…'
        : engine?.preparing
          ? 'Préparation en cours…'
          : engine?.action === 'download'
            ? 'Télécharger le modèle'
            : engine?.action === 'load'
              ? 'Charger le modèle'
              : 'Lire la page entière';

    return (
        <aside
            aria-label="Outils d’annotation"
            className="relative z-40 hidden h-full w-[288px] shrink-0 flex-col border-r border-white/10 bg-[#0b1420] text-sm text-slate-200 lg:flex"
        >
            <header className="shrink-0 border-b border-white/10 p-4">
                <Link
                    href={
                        !mangaSlug
                            ? '/'
                            : fromSearch
                              ? `/${mangaSlug}/search`
                              : `/${mangaSlug}/dashboard`
                    }
                    className="mb-5 inline-flex items-center gap-2 rounded-sm text-xs text-slate-400 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-sky-400"
                >
                    <ArrowLeft size={14} />
                    {!mangaSlug
                        ? 'Accueil'
                        : fromSearch
                          ? 'Recherche'
                          : 'Tableau de bord'}
                </Link>
                <h2 className="text-base font-semibold text-white">
                    {page.chapitres
                        ? `Chapitre ${page.chapitres.numero}`
                        : 'Page de test'}
                    {page.chapitres?.tomes && (
                        <span className="ml-2 text-xs font-normal text-slate-400">
                            Tome {page.chapitres.tomes.numero}
                        </span>
                    )}
                </h2>
                <div className="mt-3 flex items-center justify-between gap-2">
                    {!isGuest && !isSandbox && (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Page précédente"
                            disabled={!navContext.prev}
                            onClick={goToPrev}
                            className="text-slate-300 hover:bg-white/10 hover:text-white"
                        >
                            <ChevronLeft />
                        </Button>
                    )}
                    <span className="flex-1 text-center text-sm tabular-nums text-slate-200">
                        Page {page.numero_page || 1}
                        {chapterPages.length > 0 && (
                            <span className="text-slate-400">
                                {' '}
                                / {chapterPages.length}
                            </span>
                        )}
                    </span>
                    {!isGuest && !isSandbox && (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Page suivante"
                            disabled={!navContext.next}
                            onClick={goToNext}
                            className="text-slate-300 hover:bg-white/10 hover:text-white"
                        >
                            <ChevronRight />
                        </Button>
                    )}
                </div>
                {!isSandbox && (
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                        <span className="text-xs text-slate-400">Statut</span>
                        {canInlineEditStatus ? (
                            <Select
                                value={page.statut}
                                onValueChange={handlePageStatusChange}
                                disabled={isUpdatingPageStatus}
                            >
                                <SelectTrigger
                                    aria-label="État de la page"
                                    className="h-8 w-auto gap-3 border-white/10 bg-transparent text-xs text-slate-200 shadow-none"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PAGE_STATUSES.map((status) => (
                                        <SelectItem
                                            key={status.value}
                                            value={status.value}
                                        >
                                            {status.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        ) : (
                            <span className="text-xs text-slate-300">
                                {formatPageStatus(page?.statut, isGuest)}
                            </span>
                        )}
                    </div>
                )}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {!isGuest && isStaff && (
                    <>
                        {role === 'Admin' && engine && (
                            <section
                                aria-labelledby="page-ocr-heading"
                                className="border-b border-white/10 p-4"
                            >
                                <h3
                                    id="page-ocr-heading"
                                    className="mb-3 font-medium text-white"
                                >
                                    Page entière
                                </h3>
                                <Select
                                    value={engine.key}
                                    onValueChange={setSelectedEngine}
                                    disabled={Boolean(running)}
                                >
                                    <SelectTrigger
                                        aria-label="Moteur pour la page entière"
                                        className="h-10 w-full border-white/15 bg-transparent text-[13px] shadow-none"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {engines.map((item) => (
                                            <SelectItem
                                                key={item.key}
                                                value={item.key}
                                            >
                                                {item.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {engine.model && (
                                    <p className="mt-2 break-words text-xs text-slate-400">
                                        {engine.model}
                                    </p>
                                )}
                                <Button
                                    onClick={engine.handler}
                                    disabled={
                                        busy ||
                                        engine.disabled ||
                                        !engine.handler
                                    }
                                    className="mt-3 h-10 w-full bg-[#dbe5ef] text-[13px] font-medium text-[#0b1420] shadow-none hover:bg-[#f1f5f9]"
                                >
                                    {running || engine.preparing ? (
                                        <Loader2 className="animate-spin" />
                                    ) : engine.action === 'download' ? (
                                        <Download />
                                    ) : (
                                        <ScanText />
                                    )}
                                    {actionLabel}
                                </Button>
                                {engine.message && (
                                    <div
                                        role="status"
                                        className="mt-3 text-xs leading-relaxed text-slate-400"
                                    >
                                        {engine.message}
                                        {engine.progress !== null &&
                                            engine.progress !== undefined && (
                                                <>
                                                    <span className="ml-1 tabular-nums">
                                                        {engine.progress}%
                                                    </span>
                                                    <progress
                                                        aria-label="Téléchargement du modèle"
                                                        value={engine.progress}
                                                        max={100}
                                                        className="mt-2 h-1 w-full accent-sky-400"
                                                    />
                                                </>
                                            )}
                                    </div>
                                )}
                            </section>
                        )}

                        <section
                            aria-labelledby="bubble-ocr-heading"
                            className="p-4"
                        >
                            <h3
                                id="bubble-ocr-heading"
                                className="mb-3 font-medium text-white"
                            >
                                Bulles
                            </h3>
                            <AnnotateBubbleScanner
                                detectionStatus={detectionStatus}
                                loadDetectionModel={loadDetectionModel}
                                detectionProgress={detectionProgress}
                                downloadStats={downloadStats}
                                handleExecuteDetection={handleExecuteDetection}
                                isSubmitting={busy && !isAutoDetecting}
                                isAutoDetecting={isAutoDetecting}
                                queueLength={queueLength}
                            />
                            <details className="group mt-4" open>
                                <summary className="flex cursor-pointer list-none items-center justify-between rounded-sm py-2 text-xs text-slate-400 hover:text-white focus-visible:outline-2 focus-visible:outline-sky-400 [&::-webkit-details-marker]:hidden">
                                    Moteurs de transcription
                                    <ChevronRight
                                        size={14}
                                        className="transition-transform group-open:rotate-90"
                                    />
                                </summary>
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
                                    localSuryaModelStatus={
                                        localSuryaModelStatus
                                    }
                                    isDownloadingLocalTextModel={
                                        isDownloadingLocalTextModel
                                    }
                                    isDownloadingLocalSuryaModel={
                                        isDownloadingLocalSuryaModel
                                    }
                                    localTextDownloadState={
                                        localTextDownloadState
                                    }
                                    localSuryaDownloadState={
                                        localSuryaDownloadState
                                    }
                                    localTextDownloadProgress={
                                        localTextDownloadProgress
                                    }
                                    localSuryaDownloadProgress={
                                        localSuryaDownloadProgress
                                    }
                                    isLoadingLocalTextModel={
                                        isLoadingLocalTextModel
                                    }
                                    isLoadingLocalSuryaModel={
                                        isLoadingLocalSuryaModel
                                    }
                                    canRunLocalTextOcr={canRunLocalTextOcr}
                                    canRunLocalSuryaOcr={canRunLocalSuryaOcr}
                                    downloadLocalTextModel={
                                        downloadLocalTextModel
                                    }
                                    downloadLocalSuryaModel={
                                        downloadLocalSuryaModel
                                    }
                                    loadLocalTextModel={loadLocalTextModel}
                                    loadLocalSuryaModel={loadLocalSuryaModel}
                                />
                            </details>
                        </section>
                    </>
                )}
                {role === 'User' && !isGuest && !isSandbox && (
                    <section className="p-4 text-sm leading-relaxed text-slate-300">
                        <h3 className="mb-3 font-medium text-white">
                            Description
                        </h3>
                        <p>
                            {page.description_semantique?.content ||
                                'Aucune description.'}
                        </p>
                        {page.description_semantique?.arc && (
                            <p className="mt-4">
                                <span className="text-slate-400">Arc : </span>
                                {page.description_semantique.arc}
                            </p>
                        )}
                        {page.description_semantique?.characters?.length >
                            0 && (
                            <p className="mt-2">
                                <span className="text-slate-400">
                                    Personnages :{' '}
                                </span>
                                {page.description_semantique.characters.join(
                                    ', '
                                )}
                            </p>
                        )}
                    </section>
                )}
            </div>

            {!isGuest && isStaff && (
                <footer className="shrink-0 border-t border-white/10 p-3">
                    {!isSandbox && (
                        <Button
                            variant="ghost"
                            onClick={() => setShowDescModal(true)}
                            className="h-10 w-full justify-start text-[13px] text-slate-300 hover:bg-white/5 hover:text-white"
                        >
                            <FileText />
                            Métadonnées
                            <ChevronRight className="ml-auto text-slate-500" />
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        onClick={() => setShowApiKeyModal(true)}
                        className="h-10 w-full justify-start text-[13px] text-slate-300 hover:bg-white/5 hover:text-white"
                    >
                        <Settings2 />
                        Réglages API
                        <ChevronRight className="ml-auto text-slate-500" />
                    </Button>
                    {!isSandbox && (
                        <Button
                            onClick={handleSubmitPage}
                            disabled={
                                busy ||
                                page.statut === 'pending_review' ||
                                page.statut === 'completed'
                            }
                            className="mt-3 h-10 w-full border border-white/20 bg-transparent text-[13px] font-medium text-slate-200 shadow-none hover:bg-white/10"
                        >
                            {page.statut === 'completed'
                                ? 'Page validée'
                                : page.statut === 'pending_review'
                                  ? 'En attente de validation'
                                  : 'Envoyer en validation'}
                        </Button>
                    )}
                </footer>
            )}
        </aside>
    );
}
