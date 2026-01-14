import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, reorderBubbles, analyseBubble, savePageDescription, getMetadataSuggestions, getPages } from '../services/api';
import ValidationForm from '../components/ValidationForm';
import ApiKeyForm from '../components/ApiKeyForm';
import { useAuth } from '../context/AuthContext';
import { useWorker } from '../context/WorkerContext';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { SortableBubbleItem } from '../components/SortableBubbleItem';
import DraggableWrapper from '../components/DraggableWrapper';
import { cropImage } from '../lib/utils';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Send, Loader2, MousePointer2, Cpu, CloudLightning, Download, Settings2, FileText, Save, Plus, X, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const AnnotatePage = () => {
    const { user, session } = useAuth();
    const { pageId } = useParams();
    const navigate = useNavigate();
    const { worker, modelStatus, loadModel, downloadProgress, runOcr } = useWorker();

    // --- 1. ALL HOOKS MUST BE DECLARED HERE (Before any return) ---

    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [error, setError] = useState(null);

    const [hoveredBubble, setHoveredBubble] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [loadingText, setLoadingText] = useState("Analyse en cours...");

    const [pendingAnnotation, setPendingAnnotation] = useState(null);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [ocrSource, setOcrSource] = useState(null);

    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [rectangle, setRectangle] = useState(null);
    const [imageDimensions, setImageDimensions] = useState(null);

    const [debugImageUrl, setDebugImageUrl] = useState(null);
    const [preferLocalOCR, setPreferLocalOCR] = useState(() => localStorage.getItem('preferLocalOCR') !== 'false');

    // -- New Hooks for Semantic Description --
    const [showDescModal, setShowDescModal] = useState(false);
    const [isSavingDesc, setIsSavingDesc] = useState(false);

    // Navigation States
    const [chapterPages, setChapterPages] = useState([]);
    const [navContext, setNavContext] = useState({ prev: null, next: null });

    const containerRef = useRef(null);
    const imageRef = useRef(null);

    // Metadata Form States
    const [formData, setFormData] = useState({
        content: "",
        arc: "",
        characters: []
    });
    const [suggestions, setSuggestions] = useState({
        arcs: [],
        characters: []
    });
    const [charInput, setCharInput] = useState("");
    const [arcInput, setArcInput] = useState("");
    const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);

    // Initialiser le formulaire quand la page est chargée
    useEffect(() => {
        if (page?.description) {
            let desc = page.description;
            if (typeof desc === 'string') {
                try {
                    desc = JSON.parse(desc);
                } catch (e) {
                    desc = { content: page.description, metadata: { arc: "", characters: [] } };
                }
            }

            setFormData({
                content: desc.content || "",
                arc: desc.metadata?.arc || "",
                characters: desc.metadata?.characters || []
            });
            setArcInput(desc.metadata?.arc || "");
        } else if (page) {
            setFormData({
                content: "",
                arc: "",
                characters: []
            });
            setArcInput("");
        }
    }, [page]);

    const fetchSuggestions = useCallback(async () => {
        if (!session?.access_token) return;
        setIsFetchingSuggestions(true);
        try {
            const res = await getMetadataSuggestions(session.access_token);
            setSuggestions(res.data);
        } catch (err) {
            console.error("Erreur suggestions:", err);
        } finally {
            setIsFetchingSuggestions(false);
        }
    }, [session]);

    useEffect(() => {
        if (showDescModal) {
            fetchSuggestions();
        }
    }, [showDescModal, fetchSuggestions]);

    useEffect(() => {
        if (!worker) return;

        const handleMessage = (e) => {
            const { status, text, error, url } = e.data;

            if (status === 'debug_image') setDebugImageUrl(url);

            if (status === 'complete') {
                setPendingAnnotation(prev => ({
                    ...prev,
                    texte_propose: text
                }));
                setOcrSource('local');
                setIsSubmitting(false);
            }

            if (status === 'error') {
                if (modelStatus === 'ready') {
                    console.error("Erreur OCR:", error);
                    setIsSubmitting(false);
                }
            }
        };

        worker.addEventListener('message', handleMessage);
        return () => worker.removeEventListener('message', handleMessage);
    }, [worker, modelStatus]);

    const toggleOcrPreference = () => {
        const newValue = !preferLocalOCR;
        setPreferLocalOCR(newValue);
        localStorage.setItem('preferLocalOCR', newValue);
    };

    const fetchBubbles = useCallback(() => {
        if (pageId && session?.access_token) {
            getBubblesForPage(pageId, session.access_token)
                .then(response => {
                    const sortedBubbles = response.data.sort((a, b) => a.order - b.order);
                    setExistingBubbles(sortedBubbles);
                })
                .catch(error => console.error(error));
        }
    }, [pageId, session]);

    useEffect(() => {
        if (pageId && session?.access_token) {
            getPageById(pageId, session.access_token)
                .then(response => {
                    setPage(response.data);
                    // Fetch list of pages in chapter for navigation
                    if (response.data.id_chapitre) {
                        getPages(response.data.id_chapitre, session.access_token)
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
    }, [pageId, session?.access_token, fetchBubbles]);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            // Ignore if typing in an input or textarea
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
                // Special case for Enter in Textarea within modal
                if (e.key === 'Enter' && e.ctrlKey && pendingAnnotation) {
                    // Logic handled by the form submit or special trigger
                }

                // Allow Escape even in inputs to close modals
                if (e.key === 'Escape') {
                    if (pendingAnnotation) setPendingAnnotation(null);
                    if (showDescModal) setShowDescModal(null);
                    if (showApiKeyModal) setShowApiKeyModal(false);
                }
                return;
            }

            switch (e.key) {
                case 'ArrowLeft':
                    if (navContext.prev) navigate(`/annotate/${navContext.prev.id}`);
                    break;
                case 'ArrowRight':
                    if (navContext.next) navigate(`/annotate/${navContext.next.id}`);
                    break;
                case 'Escape':
                    if (isDrawing) {
                        setIsDrawing(false);
                        setStartPoint(null);
                        setEndPoint(null);
                    }
                    if (pendingAnnotation) setPendingAnnotation(null);
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [navContext, navigate, isDrawing, pendingAnnotation, showDescModal, showApiKeyModal]);

    const goToPrev = () => navContext.prev && navigate(`/annotate/${navContext.prev.id}`);
    const goToNext = () => navContext.next && navigate(`/annotate/${navContext.next.id}`);

    useEffect(() => {
        if (rectangle && imageRef.current) {
            const analysisData = { id_page: parseInt(pageId, 10), ...rectangle, texte_propose: '' };
            setPendingAnnotation(analysisData);
            setDebugImageUrl(null);

            if (preferLocalOCR) {
                if (modelStatus === 'ready') {
                    runLocalOcr();
                }
            } else {
                handleRetryWithCloud(analysisData);
            }
        }
    }, [rectangle, pageId]);

    const runLocalOcr = async () => {
        try {
            setLoadingText("Analyse Locale...");
            setIsSubmitting(true);
            const blob = await cropImage(imageRef.current, rectangle);
            runOcr(blob);
        } catch (err) {
            console.error(err);
            setIsSubmitting(false);
        }
    };

    const handleRetryWithCloud = (dataOverride = null) => {
        const dataToUse = dataOverride || pendingAnnotation;
        if (!dataToUse) return;

        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            if (!pendingAnnotation) setPendingAnnotation(dataToUse);
            return;
        }

        setLoadingText("Analyse Cloud (Google)...");
        setIsSubmitting(true);
        setDebugImageUrl(null);

        analyseBubble(dataToUse, session.access_token, storedKey)
            .then(response => {
                setPendingAnnotation(prev => ({ ...prev, texte_propose: response.data.texte_propose }));
                setOcrSource('cloud');
            })
            .catch(error => {
                if (error.response?.status === 400 && error.response?.data?.error?.includes('Clé')) {
                    localStorage.removeItem('google_api_key');
                    setShowApiKeyModal(true);
                }
            })
            .finally(() => setIsSubmitting(false));
    };

    const handleSaveApiKey = (key) => {
        localStorage.setItem('google_api_key', key);
        setShowApiKeyModal(false);
        // Si on a une annotation en attente, on relance
        if (pendingAnnotation) handleRetryWithCloud();
        // Si on était en train de sauver une description, on relance
        if (showDescModal) handleSaveDescription();
    };

    const handleSaveDescription = async () => {
        const payload = {
            content: formData.content,
            metadata: {
                arc: formData.arc,
                characters: formData.characters
            }
        };

        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            setShowApiKeyModal(true);
            return;
        }

        setIsSavingDesc(true);
        try {
            await savePageDescription(pageId, payload, session.access_token, storedKey);
            alert("Description et vecteurs enregistrés !");
            setShowDescModal(false);
            const res = await getPageById(pageId, session.access_token);
            setPage(res.data);
        } catch (error) {
            console.error(error);
            alert("Erreur lors de la sauvegarde.");
        } finally {
            setIsSavingDesc(false);
        }
    };

    const addCharacter = (char) => {
        const cleanChar = char.trim();
        if (cleanChar && !formData.characters.includes(cleanChar)) {
            setFormData(prev => ({
                ...prev,
                characters: [...prev.characters, cleanChar]
            }));
        }
        setCharInput("");
    };

    const removeCharacter = (char) => {
        setFormData(prev => ({
            ...prev,
            characters: prev.characters.filter(c => c !== char)
        }));
    };

    const handleEditBubble = (bubble) => setPendingAnnotation(bubble);

    const handleDeleteBubble = async (bubbleId) => {
        if (window.confirm("Supprimer cette annotation ?")) {
            try {
                await deleteBubble(bubbleId, session.access_token);
                fetchBubbles();
            } catch (error) { alert("Erreur suppression."); }
        }
    };

    const handleSuccess = () => {
        setPendingAnnotation(null);
        setRectangle(null);
        setDebugImageUrl(null);
        fetchBubbles();
    };

    const handleSubmitPage = async () => {
        if (window.confirm("Envoyer pour validation ?")) {
            try {
                const response = await submitPageForReview(pageId, session.access_token);
                setPage(response.data);
            } catch (error) { alert("Erreur soumission."); }
        }
    };

    const getContainerCoords = (event) => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const handleMouseDown = (event) => {
        if (page?.statut !== 'not_started' && page?.statut !== 'in_progress') return;
        if (isSubmitting || showApiKeyModal || showDescModal) return;

        event.preventDefault();
        setIsDrawing(true);
        const coords = getContainerCoords(event);
        setStartPoint(coords);
        setEndPoint(coords);
        setRectangle(null);
        setPendingAnnotation(null);
    };

    const handleMouseMove = (event) => {
        const coords = getContainerCoords(event);
        if (coords) setMousePos(coords);
        if (!isDrawing) return;
        event.preventDefault();
        setEndPoint(coords);
    };

    const handleMouseUp = (event) => {
        if (!isDrawing) return;
        event.preventDefault();
        setIsDrawing(false);

        const imageEl = imageRef.current;
        if (!imageEl || !startPoint || !endPoint || imageEl.naturalWidth === 0) return;

        const scale = imageEl.naturalWidth / imageEl.offsetWidth;
        const currentEndPoint = getContainerCoords(event) || endPoint;

        const unscaledRect = {
            x: Math.min(startPoint.x, currentEndPoint.x),
            y: Math.min(startPoint.y, currentEndPoint.y),
            w: Math.abs(startPoint.x - currentEndPoint.x),
            h: Math.abs(startPoint.y - currentEndPoint.y),
        };

        if (unscaledRect.w > 10 && unscaledRect.h > 10) {
            setRectangle({
                x: Math.round(unscaledRect.x * scale),
                y: Math.round(unscaledRect.y * scale),
                w: Math.round(unscaledRect.w * scale),
                h: Math.round(unscaledRect.h * scale),
            });
        } else {
            setStartPoint(null);
            setEndPoint(null);
        }
    };

    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);

                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(orderedBubblesForApi, session.access_token).catch(() => fetchBubbles());
                return newOrder;
            });
        }
    };

    // --- Conditional Returns MUST be after all hooks ---
    if (error) return <div className="p-8 text-red-500">{error}</div>;
    if (!page) return <div className="flex h-screen items-center justify-center text-slate-500">Chargement...</div>;

    const canEdit = page.statut === 'not_started' || page.statut === 'in_progress';

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-slate-50">
            <header className="flex-none h-16 border-b border-slate-200 bg-white px-6 flex items-center justify-between z-20 shadow-sm gap-4">
                <div className="flex items-center gap-4">
                    <Link to="/">
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4 mr-2" /> Retour
                        </Button>
                    </Link>
                    <div className="h-6 w-px bg-slate-200" />
                    <div>
                        <h2 className="text-lg font-bold text-slate-900 hidden md:block">
                            Tome {page.chapitres?.tomes?.numero} - Ch.{page.chapitres?.numero}
                        </h2>
                        <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
                            Page {page.numero_page}
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{page.statut}</Badge>
                        </div>
                    </div>

                    <div className="flex items-center gap-1 ml-4">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={!navContext.prev}
                            onClick={goToPrev}
                            title="Page précédente (←)"
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </Button>
                        <span className="text-xs font-medium text-slate-400 min-w-[60px] text-center">
                            {chapterPages.findIndex(p => p.id === parseInt(pageId)) + 1} / {chapterPages.length}
                        </span>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={!navContext.next}
                            onClick={goToNext}
                            title="Page suivante (→)"
                        >
                            <ChevronRight className="h-5 w-5" />
                        </Button>
                    </div>
                </div>

                <div className="flex items-center gap-3 ml-auto">
                    <div className="flex items-center gap-3 bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                        <div className="flex items-center gap-2 px-2">
                            <Label htmlFor="ocr-mode" className="text-xs font-medium text-slate-600 cursor-pointer">
                                {preferLocalOCR ? "Local" : "Cloud"}
                            </Label>
                            <button
                                id="ocr-mode"
                                onClick={toggleOcrPreference}
                                className={cn(
                                    "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none",
                                    preferLocalOCR ? "bg-emerald-500" : "bg-blue-500"
                                )}
                            >
                                <span className={cn(
                                    "inline-block h-3 w-3 transform rounded-full bg-white transition-transform",
                                    preferLocalOCR ? "translate-x-5" : "translate-x-1"
                                )} />
                            </button>
                        </div>

                        <div className="h-4 w-px bg-slate-200" />

                        {modelStatus === 'idle' && preferLocalOCR && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={loadModel}
                                className="h-7 text-xs border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                            >
                                <Download className="h-3 w-3 mr-1.5" />
                                Charger Modèle
                            </Button>
                        )}

                        {modelStatus === 'loading' && (
                            <div className="flex flex-col w-32 gap-1">
                                <div className="flex justify-between text-[9px] text-slate-500">
                                    <span>Chargement...</span>
                                    <span>{downloadProgress}%</span>
                                </div>
                                <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-emerald-500 transition-all duration-300"
                                        style={{ width: `${downloadProgress}%` }}
                                    />
                                </div>
                            </div>
                        )}

                        {modelStatus === 'ready' && (
                            <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 text-[10px] gap-1 h-7">
                                <Cpu className="h-3 w-3" /> Prêt
                            </Badge>
                        )}

                        {modelStatus === 'error' && (
                            <Badge variant="destructive" className="text-[10px] h-7">Erreur</Badge>
                        )}
                    </div>

                    <div className="h-6 w-px bg-slate-200" />

                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowDescModal(true)}
                        className="hidden md:flex gap-2 border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
                    >
                        <FileText className="h-4 w-4" />
                        Métadonnées
                    </Button>

                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowApiKeyModal(true)}
                        className="h-9 w-9 text-slate-400 hover:text-slate-900"
                    >
                        <Settings2 className="h-4 w-4" />
                    </Button>

                    <Button
                        className="bg-slate-900 hover:bg-slate-800"
                        onClick={handleSubmitPage}
                        disabled={!canEdit}
                    >
                        <Send className="h-3 w-3 mr-2" /> Soumettre
                    </Button>
                </div>
            </header>

            {/* Image Prefetching */}
            {navContext.next && (
                <link rel="prefetch" href={navContext.next.url_image} />
            )}

            <div className="flex flex-1 overflow-hidden">
                <main className="flex-1 bg-slate-200/50 overflow-auto flex justify-center p-8 relative cursor-default">
                    <div
                        ref={containerRef}
                        className={cn(
                            "relative inline-block bg-white shadow-xl select-none max-w-none h-fit",
                            canEdit ? "cursor-crosshair" : "cursor-default"
                        )}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp}
                    >
                        <img
                            ref={imageRef}
                            src={page.url_image}
                            crossOrigin="anonymous"
                            alt={`Page ${page.numero_page}`}
                            className="block max-w-full h-auto pointer-events-none"
                            onLoad={(e) => setImageDimensions({
                                width: e.target.offsetWidth,
                                naturalWidth: e.target.naturalWidth
                            })}
                        />

                        {isSubmitting && (
                            <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-50 flex flex-col items-center justify-center text-slate-800 font-semibold">
                                <Loader2 className="h-10 w-10 animate-spin mb-2 text-slate-900" />
                                <span>{loadingText}</span>
                            </div>
                        )}

                        {isDrawing && startPoint && endPoint && (
                            <div
                                style={{
                                    left: Math.min(startPoint.x, endPoint.x),
                                    top: Math.min(startPoint.y, endPoint.y),
                                    width: Math.abs(startPoint.x - endPoint.x),
                                    height: Math.abs(startPoint.y - endPoint.y),
                                }}
                                className="absolute border-2 border-dashed border-red-500 bg-red-500/10 pointer-events-none z-20"
                            />
                        )}

                        {imageDimensions && existingBubbles.map((bubble, index) => {
                            const scale = imageDimensions.width / imageDimensions.naturalWidth;
                            if (!scale) return null;

                            const style = {
                                left: `${bubble.x * scale}px`,
                                top: `${bubble.y * scale}px`,
                                width: `${bubble.w * scale}px`,
                                height: `${bubble.h * scale}px`,
                            };

                            const colorClass = bubble.statut === 'Validé'
                                ? "border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20"
                                : "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20";

                            return (
                                <div
                                    key={bubble.id}
                                    style={style}
                                    className={cn("absolute border-2 z-10 transition-colors cursor-pointer group", colorClass)}
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleEditBubble(bubble);
                                    }}
                                >
                                    <div className={cn(
                                        "absolute -top-6 -left-[2px] text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm",
                                        bubble.statut === 'Validé' ? "bg-emerald-500" : "bg-amber-500"
                                    )}>
                                        #{index + 1}
                                    </div>
                                </div>
                            );
                        })}

                        {hoveredBubble && (
                            <div
                                className="fixed z-50 pointer-events-none bg-slate-900/95 text-white p-3 rounded-lg shadow-xl border border-slate-700 backdrop-blur-sm max-w-[300px]"
                                style={{
                                    left: 0, top: 0,
                                    transform: `translate(${mousePos.x + 20 + containerRef.current?.getBoundingClientRect().left}px, ${mousePos.y + 20 + containerRef.current?.getBoundingClientRect().top}px)`
                                }}
                            >
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                                    Bulle #{existingBubbles.findIndex(b => b.id === hoveredBubble.id) + 1}
                                </div>
                                <p className="text-sm font-medium leading-relaxed">{hoveredBubble.texte_propose}</p>
                            </div>
                        )}
                    </div>
                </main>

                <aside className="w-[380px] bg-white border-l border-slate-200 flex flex-col h-full overflow-hidden z-10 shadow-lg">
                    <div className="flex-none p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                        <h3 className="font-semibold text-slate-900">Annotations</h3>
                        <Badge variant="secondary">{existingBubbles.length}</Badge>
                    </div>
                    <ScrollArea className="flex-1 w-full h-full">
                        <div className="flex flex-col w-full max-w-full px-4 py-4 pb-20 overflow-x-hidden">
                            {existingBubbles.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-10 text-center border-2 border-dashed border-slate-200 rounded-lg bg-slate-50/50 text-slate-500">
                                    <MousePointer2 className="h-8 w-8 mb-2 text-slate-300" />
                                    <p className="text-sm font-medium">Aucune annotation</p>
                                    <p className="text-xs mt-1">Dessinez un rectangle sur l'image<br />pour commencer.</p>
                                </div>
                            ) : (
                                <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                                    <SortableContext items={existingBubbles.map(b => b.id)} strategy={verticalListSortingStrategy}>
                                        <ul className="flex flex-col gap-3 w-full max-w-full">
                                            {existingBubbles.map((bubble, index) => (
                                                <SortableBubbleItem
                                                    key={bubble.id}
                                                    id={bubble.id}
                                                    bubble={bubble}
                                                    index={index}
                                                    user={user}
                                                    onEdit={handleEditBubble}
                                                    onDelete={handleDeleteBubble}
                                                    disabled={!canEdit}
                                                />
                                            ))}
                                        </ul>
                                    </SortableContext>
                                </DndContext>
                            )}
                        </div>
                    </ScrollArea>
                </aside>
            </div>

            <Dialog
                open={!!pendingAnnotation && !isSubmitting}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingAnnotation(null);
                        setRectangle(null);
                        setDebugImageUrl(null);
                    }
                }}
            >
                <DialogContent
                    className="max-w-none w-full h-full bg-transparent border-0 shadow-none p-0 flex items-center justify-center pointer-events-none"
                    showCloseButton={false}
                    aria-describedby={undefined}
                >
                    <div className="sr-only">
                        <DialogTitle>Édition de l'annotation</DialogTitle>
                        <DialogDescription>Zone d'édition</DialogDescription>
                    </div>

                    {pendingAnnotation && (
                        <div className="pointer-events-auto flex flex-col items-center gap-2">
                            <DraggableWrapper
                                title={
                                    <div className="flex items-center gap-2">
                                        {pendingAnnotation?.id ? "Modifier" : "Nouvelle"} annotation
                                        {ocrSource === 'local' && (
                                            <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-200 bg-emerald-50">
                                                <Cpu className="h-3 w-3 mr-1" /> Local IA
                                            </Badge>
                                        )}
                                        {ocrSource === 'cloud' && (
                                            <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-200 bg-blue-50">
                                                <CloudLightning className="h-3 w-3 mr-1" /> Cloud IA
                                            </Badge>
                                        )}
                                    </div>
                                }
                                onClose={() => {
                                    setPendingAnnotation(null);
                                    setRectangle(null);
                                    setDebugImageUrl(null);
                                }}
                                className="w-full max-w-lg"
                            >
                                <div className="p-6">
                                    <ValidationForm
                                        annotationData={pendingAnnotation}
                                        onValidationSuccess={handleSuccess}
                                        onCancel={() => {
                                            setPendingAnnotation(null);
                                            setRectangle(null);
                                            setDebugImageUrl(null);
                                        }}
                                    />

                                    {debugImageUrl && (
                                        <div className="mt-4 flex justify-center">
                                            <img
                                                src={debugImageUrl}
                                                alt="Debug"
                                                className="max-h-24 object-contain border border-slate-200 shadow-sm rounded bg-white p-1"
                                            />
                                        </div>
                                    )}

                                    <div className="mt-4 pt-4 border-t border-slate-100 flex justify-center">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-xs text-slate-500 hover:text-slate-900"
                                            onClick={() => handleRetryWithCloud()}
                                        >
                                            <CloudLightning className="h-3 w-3 mr-1" />
                                            {preferLocalOCR ? "Réessayer avec l'IA Cloud" : "Relancer l'analyse Cloud"}
                                        </Button>
                                    </div>
                                </div>
                            </DraggableWrapper>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API Google Vision</DialogTitle>
                        <DialogDescription>Requis pour le Cloud et l'Embedding.</DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>

            <Dialog open={showDescModal} onOpenChange={setShowDescModal}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <FileText className="h-5 w-5 text-indigo-600" />
                            Description Sémantique de la Page
                        </DialogTitle>
                        <DialogDescription>
                            Ces informations seront vectorisées pour permettre la recherche sémantique intelligente.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-6 py-4">
                        {/* Contenu de la scène */}
                        <div className="flex flex-col gap-3">
                            <Label htmlFor="scene-content" className="text-sm font-semibold text-slate-700">
                                Contenu Sémantique
                            </Label>
                            <Textarea
                                id="scene-content"
                                value={formData.content}
                                onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                                className="min-h-[120px] resize-none border-slate-200 focus:ring-indigo-500"
                                placeholder="Décrivez ce qui se passe dans cette page (actions, lieux, ambiance)..."
                            />
                            <p className="text-[10px] text-slate-400 italic">
                                Exemple: Luffy utilise son Gear Second contre Lucci dans la tour de la justice.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* Arc Narratif */}
                            <div className="flex flex-col gap-3">
                                <Label htmlFor="arc-select" className="text-sm font-semibold text-slate-700">
                                    Arc Narratif
                                </Label>
                                <div className="relative">
                                    <input
                                        list="arc-suggestions"
                                        id="arc-select"
                                        value={arcInput}
                                        onChange={(e) => {
                                            setArcInput(e.target.value);
                                            setFormData(prev => ({ ...prev, arc: e.target.value }));
                                        }}
                                        className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-white file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                        placeholder="Choisir ou saisir un arc..."
                                    />
                                    <datalist id="arc-suggestions">
                                        {suggestions.arcs.map(arc => (
                                            <option key={arc} value={arc} />
                                        ))}
                                    </datalist>
                                </div>
                            </div>

                            {/* Personnages */}
                            <div className="flex flex-col gap-3">
                                <Label className="text-sm font-semibold text-slate-700">
                                    Personnages Présents
                                </Label>
                                <div className="flex flex-col gap-2">
                                    <div className="relative flex items-center gap-2">
                                        <input
                                            list="char-suggestions"
                                            value={charInput}
                                            onChange={(e) => setCharInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    addCharacter(charInput);
                                                }
                                            }}
                                            className="flex h-10 flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                            placeholder="Ajouter un personnage..."
                                        />
                                        <datalist id="char-suggestions">
                                            {suggestions.characters.map(char => (
                                                <option key={char} value={char} />
                                            ))}
                                        </datalist>
                                        <Button
                                            size="icon"
                                            variant="secondary"
                                            className="h-10 w-10 shrink-0"
                                            onClick={() => addCharacter(charInput)}
                                        >
                                            <Plus className="h-4 w-4" />
                                        </Button>
                                    </div>

                                    <div className="flex flex-wrap gap-1.5 p-2 bg-slate-50 rounded-md border border-dashed border-slate-200 min-h-[44px]">
                                        {formData.characters.length === 0 ? (
                                            <span className="text-xs text-slate-400 m-auto">Aucun personnage ajouté</span>
                                        ) : (
                                            formData.characters.map((char) => (
                                                <Badge
                                                    key={char}
                                                    variant="secondary"
                                                    className="pl-2 pr-1 py-1 gap-1 bg-white border-slate-200 text-slate-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200 transition-colors group"
                                                >
                                                    {char}
                                                    <button
                                                        onClick={() => removeCharacter(char)}
                                                        className="h-4 w-4 rounded-full flex items-center justify-center hover:bg-red-100 transition-colors"
                                                    >
                                                        <X className="h-3 w-3" />
                                                    </button>
                                                </Badge>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="gap-2 pt-4 border-t border-slate-100">
                        <Button variant="ghost" onClick={() => setShowDescModal(false)}>
                            Annuler
                        </Button>
                        <Button
                            onClick={handleSaveDescription}
                            disabled={isSavingDesc}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[200px]"
                        >
                            {isSavingDesc ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Traitement...</>
                            ) : (
                                <><Save className="mr-2 h-4 w-4" /> Enregistrer & Vectoriser</>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default AnnotatePage;