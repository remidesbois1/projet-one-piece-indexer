"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, reorderBubbles, savePageDescription, getMetadataSuggestions, getPages } from '@/lib/api';
import { analyzeBubble, generatePageDescription, generateGeminiEmbedding } from '@/lib/geminiClient';
import ApiKeyForm from '@/components/ApiKeyForm';
import { useAuth } from '@/context/AuthContext';
import { OCR_MODELS } from '@/context/WorkerContext';
import { useManga } from '@/context/MangaContext';
import { arrayMove } from '@dnd-kit/sortable';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import { useAnnotationOCR } from '@/hooks/useAnnotationOCR';
import { useAnnotationDetection } from '@/hooks/useAnnotationDetection';
import { useAnnotationMetadata } from '@/hooks/useAnnotationMetadata';
import { getProxiedImageUrl } from '@/lib/utils';
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowLeft, Send, X, Shield, FileText } from "lucide-react";
import { toast } from "sonner";
import AnnotateLeftSidebar from '@/components/AnnotateLeftSidebar';
import AnnotateCanvas from '@/components/AnnotateCanvas';
import AnnotateAnnotationSidebar from '@/components/AnnotateAnnotationSidebar';
import AnnotateEditorDialog from '@/components/AnnotateEditorDialog';
import AnnotateMetadataModal from '@/components/AnnotateMetadataModal';

export default function AnnotatePage() {
    const { user, session, isGuest } = useAuth();
    const params = useParams();
    const searchParams = useSearchParams();
    const fromSearch = searchParams.get('from') === 'search';
    const pageId = params?.pageId;
    const router = useRouter();
    const { mangaSlug, currentManga } = useManga();

    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [error, setError] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [loadingText, setLoadingText] = useState("Analyse en cours...");
    const [pendingAnnotation, setPendingAnnotation] = useState(null);
    const [rectangle, setRectangle] = useState(null);
    const [imageDimensions, setImageDimensions] = useState(null);
    const [ocrSource, setOcrSource] = useState(null);
    const [debugImageUrl, setDebugImageUrl] = useState(null);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [showDescModal, setShowDescModal] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const containerRef = useRef(null);
    const imageRef = useRef(null);

    const [chapterPages, setChapterPages] = useState([]);
    const [navContext, setNavContext] = useState({ prev: null, next: null });
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    useEffect(() => {
        const imgEl = imageRef.current;
        if (!imgEl) return;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry && imgEl.naturalWidth) {
                setImageDimensions({
                    width: imgEl.offsetWidth,
                    naturalWidth: imgEl.naturalWidth,
                    naturalHeight: imgEl.naturalHeight
                });
            }
        });
        observer.observe(imgEl);
        return () => observer.disconnect();
    }, [pageId, page]);

    const {
        formData, setFormData, suggestions, charInput, setCharInput,
        isSavingDesc, isGeneratingAI, tabMode, setTabMode, jsonInput,
        jsonError, handleJsonChange, handleSaveDescription, handleGenerateAI,
        addCharacter, removeCharacter
    } = useAnnotationMetadata({
        page, setPage, pageId, imageRef, showDescModal, setShowDescModal, setShowApiKeyModal
    });

    const {
        preferLocalOCR, toggleOcrPreference, geminiKey, activeModelKey,
        modelStatus, loadModel, switchModel, downloadProgress, runLocalOcr,
        handleRetryWithCloud
    } = useAnnotationOCR({
        imageRef, pageId, rectangle, pendingAnnotation, setPendingAnnotation,
        setIsSubmitting, setLoadingText, setIsModalOpen, setOcrSource,
        setDebugImageUrl, setShowApiKeyModal
    });

    const {
        isAutoDetecting, setIsAutoDetecting, queueLength, detectionStatus,
        loadDetectionModel, detectionProgress, handleExecuteDetection,
        processNextBubble
    } = useAnnotationDetection({
        imageRef, pageId, setRectangle, setPendingAnnotation, setDebugImageUrl,
        runLocalOcr, setIsSubmitting, setLoadingText
    });

    const {
        isDrawing, startPoint, endPoint, mousePos, isShiftPressed,
        hoveredBubble, setHoveredBubble, handleMouseDown, handleMouseMove,
        handleMouseUp, handleInteractionStart
    } = useAnnotationInteractions({
        containerRef, imageRef, imageDimensions, existingBubbles, setExistingBubbles,
        pendingAnnotation, setPendingAnnotation, setRectangle, isGuest, isMobile,
        pageStatus: page?.statut, isSubmitting, showApiKeyModal, showDescModal
    });

    const fetchBubbles = useCallback(() => {
        if (pageId && (session?.access_token || isGuest)) {
            getBubblesForPage(pageId)
                .then(response => {
                    const sortedBubbles = response.data.sort((a, b) => a.order - b.order);
                    setExistingBubbles(sortedBubbles);
                })
                .catch(error => console.error(error));
        }
    }, [pageId, session, isGuest]);

    useEffect(() => {
        if (pageId && (session?.access_token || isGuest)) {
            getPageById(pageId)
                .then(response => {
                    setPage(response.data);
                    if (response.data.id_chapitre) {
                        getPages(response.data.id_chapitre)
                            .then(pagesRes => {
                                const pages = pagesRes.data;
                                setChapterPages(pages);
                                const currentIndex = pages.findIndex(p => p.id === parseInt(pageId));
                                setNavContext({
                                    prev: currentIndex > 0 ? pages[currentIndex - 1] : null,
                                    next: currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null
                                });
                            });
                    }
                })
                .catch(() => setError("Impossible de charger la page."));
            fetchBubbles();
        }
    }, [pageId, session?.access_token, isGuest, fetchBubbles]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
                if (e.key === 'Escape') {
                    if (pendingAnnotation) setPendingAnnotation(null);
                    if (showDescModal) setShowDescModal(false);
                    if (showApiKeyModal) setShowApiKeyModal(false);
                }
                return;
            }
            switch (e.key) {
                case 'ArrowLeft':
                    if (navContext.prev) router.push(`/${mangaSlug}/annotate/${navContext.prev.id}`);
                    break;
                case 'ArrowRight':
                    if (navContext.next) router.push(`/${mangaSlug}/annotate/${navContext.next.id}`);
                    break;
                case 'Escape':
                    if (isDrawing) { /* dealt with in hook but can be here too */ }
                    if (pendingAnnotation) setPendingAnnotation(null);
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [navContext, router, pendingAnnotation, showDescModal, showApiKeyModal, mangaSlug, isDrawing]);

    const goToPrev = () => navContext.prev && router.push(`/${mangaSlug}/annotate/${navContext.prev.id}`);
    const goToNext = () => navContext.next && router.push(`/${mangaSlug}/annotate/${navContext.next.id}`);

    useEffect(() => {
        if (isAutoDetecting) return;
        if (rectangle && imageRef.current) {
            const analysisData = { id_page: parseInt(pageId, 10), ...rectangle, texte_propose: '' };
            setPendingAnnotation(analysisData);
            setDebugImageUrl(null);
            runLocalOcr();
        }
    }, [rectangle, pageId, isAutoDetecting, activeModelKey]);

    const handleSaveApiKey = (key) => {
        localStorage.setItem('google_api_key', key);
        setShowApiKeyModal(false);
        if (pendingAnnotation) handleRetryWithCloud();
        if (showDescModal) handleSaveDescription();
    };

    const handleEditBubble = (bubble) => {
        if (isGuest || isMobile) return;
        setPendingAnnotation(bubble);
        setIsModalOpen(true);
    };

    const handleDeleteBubble = async (bubbleId) => {
        if (isGuest || isMobile) return;
        if (window.confirm("Supprimer cette annotation ?")) {
            const previousBubbles = [...existingBubbles];
            setExistingBubbles(prev => prev.filter(b => b.id !== bubbleId));
            try {
                await deleteBubble(bubbleId);
                toast.success("Annotation supprimée.");
            } catch (error) {
                setExistingBubbles(previousBubbles);
                toast.error("Erreur lors de la suppression.");
            }
        }
    };

    const handleSuccess = (newData) => {
        setPendingAnnotation(null);
        setDebugImageUrl(null);
        setIsModalOpen(false);
        if (newData) {
            setExistingBubbles(prev => {
                const exists = prev.find(b => b.id === newData.id);
                if (exists) return prev.map(b => b.id === newData.id ? { ...b, ...newData } : b);
                return [...prev, newData].sort((a, b) => a.order - b.order);
            });
        }
        if (isAutoDetecting) {
            setTimeout(() => processNextBubble(), 300);
        } else {
            setRectangle(null);
        }
    };

    const handleSubmitPage = async () => {
        if (isGuest || isMobile) return;
        if (window.confirm("Envoyer pour validation ?")) {
            try {
                const response = await submitPageForReview(pageId);
                setPage(response.data);
                toast.success("Page soumise pour validation !");
            } catch (error) { toast.error("Erreur soumission."); }
        }
    };

    const handleDragEnd = (event) => {
        if (isGuest) return;
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);
                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(orderedBubblesForApi).catch(() => fetchBubbles());
                return newOrder;
            });
        }
    };

    if (error) return <div className="p-8 text-red-500">{error}</div>;
    if (!page) return null;

    const canEdit = !isGuest && (page.statut === 'not_started' || page.statut === 'in_progress');

    return (
        <div className="flex flex-col lg:flex-row h-[calc(100vh-64px)] bg-slate-50 overflow-hidden -mx-4 sm:-mx-8 -my-6 relative">
            
            <AnnotateLeftSidebar 
                fromSearch={fromSearch}
                mangaSlug={mangaSlug}
                page={page}
                chapterPages={chapterPages}
                navContext={navContext}
                goToPrev={goToPrev}
                goToNext={goToNext}
                isGuest={isGuest}
                preferLocalOCR={preferLocalOCR}
                toggleOcrPreference={toggleOcrPreference}
                activeModelKey={activeModelKey}
                switchModel={switchModel}
                modelStatus={modelStatus}
                loadModel={loadModel}
                downloadProgress={downloadProgress}
                geminiKey={geminiKey}
                detectionStatus={detectionStatus}
                loadDetectionModel={loadDetectionModel}
                detectionProgress={detectionProgress}
                handleExecuteDetection={handleExecuteDetection}
                isSubmitting={isSubmitting}
                isAutoDetecting={isAutoDetecting}
                queueLength={queueLength}
                setShowDescModal={setShowDescModal}
                setShowApiKeyModal={setShowApiKeyModal}
                handleSubmitPage={handleSubmitPage}
            />

            <div className="flex flex-col flex-1 overflow-hidden min-w-0 bg-slate-50 relative">

                <header className="lg:hidden flex-none h-auto min-h-16 border-b border-slate-200 bg-white px-4 py-3 flex items-center justify-between z-20 shadow-sm">
                    <div className="flex items-center gap-3 shrink-0">
                        <Link href={`/${mangaSlug}/dashboard`}>
                            <Button variant="ghost" size="icon" className="h-9 w-9">
                                <ArrowLeft className="h-5 w-5" />
                            </Button>
                        </Link>
                        <div className="flex flex-col">
                            <h2 className="text-sm font-bold text-slate-900 truncate max-w-[120px]">
                                T.{page.chapitres?.tomes?.numero} - Ch.{page.chapitres?.numero}
                            </h2>
                            <span className="text-[10px] text-slate-500">Page {page.numero_page}</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setShowDescModal(true)}>
                            <FileText size={16} />
                        </Button>
                        <Button variant="default" size="sm" className="h-9" disabled={page.statut === 'pending_review' || page.statut === 'completed'} onClick={handleSubmitPage}>
                            <Send size={14} className="mr-2" /> Soumettre
                        </Button>
                    </div>
                </header>

                {isGuest && (
                    <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center justify-center gap-2 text-amber-800 text-sm font-medium">
                        <Shield className="h-4 w-4" />
                        Mode Lecture Seule : La modification des données est réservée aux utilisateurs connectés.
                    </div>
                )}

                {page.commentaire_moderation && page.statut !== 'completed' && (
                    <div className="bg-red-50 border-b border-red-200 px-6 py-3 flex items-center gap-3 text-red-800 text-sm animate-in slide-in-from-top duration-300">
                        <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                            <X className="h-4 w-4 text-red-600" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold">Cette page a été refusée par la modération</p>
                            <p className="text-red-700/80 italic font-medium">"{page.commentaire_moderation}"</p>
                        </div>
                    </div>
                )}

                <div className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-0">
                    <AnnotateCanvas 
                        canEdit={canEdit}
                        imageDimensions={imageDimensions}
                        setImageDimensions={setImageDimensions}
                        containerRef={containerRef}
                        imageRef={imageRef}
                        handleMouseDown={handleMouseDown}
                        handleMouseMove={handleMouseMove}
                        handleMouseUp={handleMouseUp}
                        imageUrl={getProxiedImageUrl(page.url_image, pageId, session?.access_token)}
                        isSubmitting={isSubmitting}
                        loadingText={loadingText}
                        rectangle={rectangle}
                        pendingAnnotation={pendingAnnotation}
                        isAutoDetecting={isAutoDetecting}
                        isShiftPressed={isShiftPressed}
                        handleInteractionStart={handleInteractionStart}
                        setIsModalOpen={setIsModalOpen}
                        isDrawing={isDrawing}
                        startPoint={startPoint}
                        endPoint={endPoint}
                        existingBubbles={existingBubbles}
                        setHoveredBubble={setHoveredBubble}
                        hoveredBubble={hoveredBubble}
                        mousePos={mousePos}
                        handleEditBubble={handleEditBubble}
                    />

                    <AnnotateAnnotationSidebar 
                        existingBubbles={existingBubbles}
                        handleDragEnd={handleDragEnd}
                        user={user}
                        handleEditBubble={handleEditBubble}
                        handleDeleteBubble={handleDeleteBubble}
                        canEdit={canEdit}
                    />
                </div>
            </div>

            <AnnotateEditorDialog 
                isOpen={isModalOpen}
                setIsModalOpen={setIsModalOpen}
                setIsSubmitting={setIsSubmitting}
                isAutoDetecting={isAutoDetecting}
                setIsAutoDetecting={setIsAutoDetecting}
                setPendingAnnotation={setPendingAnnotation}
                setDebugImageUrl={setDebugImageUrl}
                setRectangle={setRectangle}
                pendingAnnotation={pendingAnnotation}
                ocrSource={ocrSource}
                handleSuccess={handleSuccess}
                processNextBubble={processNextBubble}
                debugImageUrl={debugImageUrl}
                runLocalOcr={runLocalOcr}
                activeModelKey={activeModelKey}
                OCR_MODELS={OCR_MODELS}
            />

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API Google Vision</DialogTitle>
                        <DialogDescription>Requis pour le Cloud et l'Embedding.</DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>

            {!isGuest && (
                <AnnotateMetadataModal 
                    isOpen={showDescModal}
                    onOpenChange={setShowDescModal}
                    tabMode={tabMode}
                    setTabMode={setTabMode}
                    formData={formData}
                    setFormData={setFormData}
                    charInput={charInput}
                    setCharInput={setCharInput}
                    suggestions={suggestions}
                    isGeneratingAI={isGeneratingAI}
                    handleGenerateAI={handleGenerateAI}
                    handleSaveDescription={handleSaveDescription}
                    isSavingDesc={isSavingDesc}
                    jsonInput={jsonInput}
                    handleJsonChange={handleJsonChange}
                    jsonError={jsonError}
                />
            )}
        </div>
    );
}
