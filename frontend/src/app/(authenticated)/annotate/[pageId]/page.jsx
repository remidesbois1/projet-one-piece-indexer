"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, reorderBubbles, savePageDescription, getMetadataSuggestions, getPages } from '@/lib/api';
import { analyzeBubble, generatePageDescription } from '@/lib/geminiClient';
import ValidationForm from '@/components/ValidationForm';
import ApiKeyForm from '@/components/ApiKeyForm';
import { useAuth } from '@/context/AuthContext';
import { useWorker } from '@/context/WorkerContext';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { SortableBubbleItem } from '@/components/SortableBubbleItem';
import DraggableWrapper from '@/components/DraggableWrapper';
import { cropImage, getProxiedImageUrl } from '@/lib/utils';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Send, Loader2, MousePointer2, Cpu, CloudLightning, Download, Settings2, FileText, Save, Plus, X, Search, ChevronLeft, ChevronRight, Shield, Code, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AnnotatePage() {
    const { user, session, isGuest } = useAuth();
    const params = useParams();
    const pageId = params?.pageId;
    const router = useRouter(); // Next.js router
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
    // Safe localStorage access
    const [preferLocalOCR, setPreferLocalOCR] = useState(false);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setPreferLocalOCR(localStorage.getItem('preferLocalOCR') !== 'false');
        }
    }, []);

    // -- New Hooks for Semantic Description --
    const [showDescModal, setShowDescModal] = useState(false);
    const [isSavingDesc, setIsSavingDesc] = useState(false);
    const [isGeneratingAI, setIsGeneratingAI] = useState(false);

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

    const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);

    const [tabMode, setTabMode] = useState("form");
    const [jsonInput, setJsonInput] = useState("");
    const [jsonError, setJsonError] = useState(null);

    useEffect(() => {
        if (tabMode === 'form') {
            const jsonStructure = {
                content: formData.content,
                metadata: {
                    arc: formData.arc,
                    characters: formData.characters
                }
            };
            setJsonInput(JSON.stringify(jsonStructure, null, 4));
            setJsonError(null);
        }
    }, [formData, tabMode]);

    const handleJsonChange = (e) => {
        const val = e.target.value;
        setJsonInput(val);
        try {
            const parsed = JSON.parse(val);

            // Validation de structure pour éviter de casser le format
            if (typeof parsed !== 'object' || parsed === null) {
                throw new Error("Le JSON doit être un objet.");
            }
            if (!parsed.metadata || typeof parsed.metadata !== 'object') {
                throw new Error("L'objet doit contenir une clé 'metadata'.");
            }

            setJsonError(null);
            setFormData(prev => ({
                ...prev,
                content: parsed.content || "",
                arc: parsed.metadata.arc || "",
                characters: Array.isArray(parsed.metadata.characters) ? parsed.metadata.characters : []
            }));
        } catch (err) {
            setJsonError(err.message);
        }
    };

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

            const newFormData = {
                content: desc.content || "",
                arc: desc.metadata?.arc || "",
                characters: desc.metadata?.characters || []
            };

            setFormData(newFormData);

            // Sync JSON input on page load regardless of tab mode
            const jsonStructure = {
                content: newFormData.content,
                metadata: {
                    arc: newFormData.arc,
                    characters: newFormData.characters
                }
            };
            setJsonInput(JSON.stringify(jsonStructure, null, 4));
            setJsonError(null);

        } else if (page) {
            const newFormData = {
                content: "",
                arc: "",
                characters: []
            };
            setFormData(newFormData);

            // Sync JSON input for empty page
            const jsonStructure = {
                content: newFormData.content,
                metadata: {
                    arc: newFormData.arc,
                    characters: newFormData.characters
                }
            };
            setJsonInput(JSON.stringify(jsonStructure, null, 4));
            setJsonError(null);
        }
    }, [page]);

    const fetchSuggestions = useCallback(async () => {
        if (!session?.access_token) return;
        setIsFetchingSuggestions(true);
        try {
            const res = await getMetadataSuggestions();
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

        const handleMessage = async (e) => {
            const { status, text, error, url } = e.data;

            if (status === 'debug_image') setDebugImageUrl(url);

            if (status === 'complete') {
                setOcrSource('local');
                setPendingAnnotation(prev => ({
                    ...prev,
                    texte_propose: text
                }));
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
                    // Fetch list of pages in chapter for navigation
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
                    if (navContext.prev) router.push(`/annotate/${navContext.prev.id}`);
                    break;
                case 'ArrowRight':
                    if (navContext.next) router.push(`/annotate/${navContext.next.id}`);
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
    }, [navContext, router, isDrawing, pendingAnnotation, showDescModal, showApiKeyModal]);

    const goToPrev = () => navContext.prev && router.push(`/annotate/${navContext.prev.id}`);
    const goToNext = () => navContext.next && router.push(`/annotate/${navContext.next.id}`);

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

        analyzeBubble(imageRef.current, dataToUse, storedKey)
            .then(response => {
                setPendingAnnotation(prev => ({ ...prev, texte_propose: response.data.texte_propose }));
                setOcrSource('cloud');
            })
            .catch(error => {
                console.error("Cloud OCR Error:", error);
                // Check for invalid API key signals from Google SDK
                if (error.message?.includes('API key') || error.toString().includes('400')) {
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
            await savePageDescription(pageId, payload);
            alert("Description et vecteurs enregistrés !");
            setShowDescModal(false);
            const res = await getPageById(pageId);
            setPage(res.data);
        } catch (error) {
            console.error(error);
            alert("Erreur lors de la sauvegarde.");
        } finally {
            setIsSavingDesc(false);
        }
    };

    const handleGenerateAI = async () => {
        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            setShowApiKeyModal(true);
            return;
        }

        setIsGeneratingAI(true);
        try {
            // Client-side generation using imageRef and local API key
            const res = await generatePageDescription(imageRef.current, storedKey);
            const aiData = res.data;

            setFormData({
                content: aiData.content || "",
                arc: aiData.metadata?.arc || "",
                characters: Array.isArray(aiData.metadata?.characters) ? aiData.metadata.characters : []
            });

            setJsonInput(JSON.stringify(aiData, null, 4));
            setJsonError(null);

        } catch (error) {
            console.error("Erreur génération AI:", error);
            alert("Erreur lors de la génération par IA. Vérifiez votre clé API.");
        } finally {
            setIsGeneratingAI(false);
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

    const handleEditBubble = (bubble) => {
        if (isGuest) return;
        setPendingAnnotation(bubble);
    };

    const handleDeleteBubble = async (bubbleId) => {
        if (isGuest) return;
        if (window.confirm("Supprimer cette annotation ?")) {
            try {
                await deleteBubble(bubbleId);
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
        if (isGuest) return;
        if (window.confirm("Envoyer pour validation ?")) {
            try {
                const response = await submitPageForReview(pageId);
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
        if (isGuest) return;
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
    if (!page) return <div className="flex h-screen items-center justify-center text-slate-500">Chargement...</div>;

    const canEdit = !isGuest && (page.statut === 'not_started' || page.statut === 'in_progress');

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-slate-50">
            <header className="flex-none h-16 border-b border-slate-200 bg-white px-6 flex items-center justify-between z-20 shadow-sm gap-4">
                <div className="flex items-center gap-4">
                    <Link href="/dashboard">
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
                                onClick={() => !isGuest && toggleOcrPreference()}
                                disabled={isGuest}
                                className={cn(
                                    "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none",
                                    preferLocalOCR ? "bg-emerald-500" : "bg-blue-500",
                                    isGuest && "opacity-50 cursor-not-allowed"
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
                        onClick={() => !isGuest && setShowDescModal(true)}
                        disabled={isGuest}
                        className={cn(
                            "hidden md:flex gap-2 border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100",
                            isGuest && "opacity-50 cursor-not-allowed"
                        )}
                    >
                        <FileText className="h-4 w-4" />
                        Métadonnées
                    </Button>

                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => !isGuest && setShowApiKeyModal(true)}
                        className={cn("h-9 w-9 text-slate-400 hover:text-slate-900", isGuest && "opacity-50 cursor-not-allowed")}
                        disabled={isGuest}
                    >
                        <Settings2 className="h-4 w-4" />
                    </Button>

                    <Button
                        className="bg-slate-900 hover:bg-slate-800"
                        onClick={handleSubmitPage}
                        disabled={!canEdit || isGuest}
                    >
                        <Send className="h-3 w-3 mr-2" /> Soumettre
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

            {/* Image Prefetching */}
            {navContext.next && (
                <link rel="prefetch" href={getProxiedImageUrl(navContext.next.url_image)} />
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
                            src={getProxiedImageUrl(page.url_image)}
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
                        <div className="flex items-center justify-between pr-4">
                            <div>
                                <DialogTitle className="flex items-center gap-2">
                                    <FileText className="h-5 w-5 text-indigo-600" />
                                    Description Sémantique
                                </DialogTitle>
                                <DialogDescription>
                                    Définition des métadonnées pour le moteur de recherche.
                                </DialogDescription>
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleGenerateAI}
                                disabled={isGeneratingAI || isGuest}
                                className="gap-2 border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
                            >
                                {isGeneratingAI ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                Générer avec IA
                            </Button>
                        </div>
                    </DialogHeader>

                    <Tabs value={tabMode} onValueChange={setTabMode} className="w-full">
                        <TabsList className="grid w-full grid-cols-2 mb-4">
                            <TabsTrigger value="form">
                                <FileText className="h-4 w-4 mr-2" />
                                Formulaire
                            </TabsTrigger>
                            <TabsTrigger value="json">
                                <Code className="h-4 w-4 mr-2" />
                                JSON Raw
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="form" className="space-y-4 outline-none">
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
                                    placeholder="Description de l'action, des lieux..."
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* Arc Narratif */}
                                <div className="flex flex-col gap-3">
                                    <Label className="text-sm font-semibold text-slate-700">Arc Narratif</Label>
                                    <div className="relative">
                                        <input
                                            list="arc-suggestions"
                                            value={formData.arc}
                                            onChange={(e) => {
                                                setFormData(prev => ({ ...prev, arc: e.target.value }));
                                            }}
                                            className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:ring-indigo-500 focus:outline-none focus:ring-2"
                                            placeholder="Ex: Water 7"
                                        />
                                        <datalist id="arc-suggestions">
                                            {suggestions.arcs.map(arc => <option key={arc} value={arc} />)}
                                        </datalist>
                                    </div>
                                </div>

                                {/* Personnages */}
                                <div className="flex flex-col gap-3">
                                    <Label className="text-sm font-semibold text-slate-700">Personnages</Label>
                                    <div className="flex flex-col gap-2">
                                        <div className="flex gap-2">
                                            <input
                                                list="char-suggestions"
                                                value={charInput}
                                                onChange={(e) => setCharInput(e.target.value)}
                                                onKeyDown={(e) => e.key === 'Enter' && addCharacter(charInput)}
                                                className="flex h-10 flex-1 rounded-md border border-slate-200 px-3 text-sm focus:ring-indigo-500 focus:outline-none focus:ring-2"
                                                placeholder="Ajouter..."
                                            />
                                            <datalist id="char-suggestions">
                                                {suggestions.characters.map(c => <option key={c} value={c} />)}
                                            </datalist>
                                            <Button size="icon" variant="secondary" onClick={() => addCharacter(charInput)}>
                                                <Plus className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        <div className="flex flex-wrap gap-2 min-h-[40px] p-2 bg-slate-50 rounded border border-dashed border-slate-200">
                                            {formData.characters.map(char => (
                                                <Badge key={char} variant="secondary" className="gap-1 bg-white hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer" onClick={() => removeCharacter(char)}>
                                                    {char} <X className="h-3 w-3" />
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        <TabsContent value="json" className="outline-none">
                            <div className="relative">
                                <Textarea
                                    value={jsonInput}
                                    onChange={handleJsonChange}
                                    className={cn(
                                        "font-mono text-xs min-h-[350px] bg-slate-900 text-slate-50 resize-none",
                                        jsonError ? "border-red-500 focus:ring-red-500" : "border-slate-800 focus:ring-slate-700"
                                    )}
                                    spellCheck={false}
                                />
                                {jsonError && (
                                    <div className="absolute bottom-4 left-4 right-4 bg-red-500/90 text-white text-xs p-2 rounded shadow-lg backdrop-blur-sm">
                                        Erreur JSON: {jsonError}
                                    </div>
                                )}
                            </div>
                        </TabsContent>
                    </Tabs>

                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowDescModal(false)}>Fermer</Button>
                        <Button onClick={handleSaveDescription} disabled={isSavingDesc || !!jsonError} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                            {isSavingDesc ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                            Enregistrer
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
