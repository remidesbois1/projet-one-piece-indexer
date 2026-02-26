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
import { useDetection } from '@/context/DetectionContext';
import { useManga } from '@/context/MangaContext';
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
import { toast } from "sonner";

export default function AnnotatePage() {
    const { user, session, isGuest } = useAuth();
    const params = useParams();
    const pageId = params?.pageId;
    const router = useRouter();
    const { worker, modelStatus, loadModel, downloadProgress, runOcr } = useWorker();
    const {
        detectBubbles,
        detectionStatus,
        loadDetectionModel,
        downloadProgress: detectionProgress
    } = useDetection();

    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [error, setError] = useState(null);

    const [isAutoDetecting, setIsAutoDetecting] = useState(false);
    const detectionQueueRef = useRef([]);
    const [queueLength, setQueueLength] = useState(0);

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

    const [preferLocalOCR, setPreferLocalOCR] = useState(false);
    const [geminiKey, setGeminiKey] = useState(null);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setPreferLocalOCR(localStorage.getItem('preferLocalOCR') !== 'false');

            const loadKey = () => setGeminiKey(localStorage.getItem('google_api_key'));
            loadKey();
            window.addEventListener('storage', loadKey);
            return () => window.removeEventListener('storage', loadKey);
        }
    }, []);

    const [showDescModal, setShowDescModal] = useState(false);
    const [isSavingDesc, setIsSavingDesc] = useState(false);
    const [isGeneratingAI, setIsGeneratingAI] = useState(false);

    const [chapterPages, setChapterPages] = useState([]);
    const [navContext, setNavContext] = useState({ prev: null, next: null });
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const containerRef = useRef(null);
    const imageRef = useRef(null);

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

    const { mangaSlug, currentManga } = useManga();

    const pageTitle = currentManga
        ? `Annotation : ${currentManga.titre}${page?.chapitre?.titre ? ` - ${page.chapitre.titre}` : ''}`
        : "Annotation";

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

    const lastRequestId = useRef(0);

    const runLocalOcr = async () => {
        try {
            setLoadingText("Analyse Locale...");
            setIsSubmitting(true);
            const requestId = Date.now();
            lastRequestId.current = requestId;

            const blob = await cropImage(imageRef.current, rectangle);
            runOcr(blob, requestId);
        } catch (err) {
            console.error(err);
            setIsSubmitting(false);
        }
    };

    useEffect(() => {
        if (!worker) return;

        const handleMessage = async (e) => {
            const { status, text, error, url, requestId } = e.data;

            if (requestId && requestId !== lastRequestId.current) {
                console.warn(`[OCR] Ignored outdated response for ID ${requestId} (Expected: ${lastRequestId.current})`);
                return;
            }

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
                if (e.key === 'Enter' && e.ctrlKey && pendingAnnotation) {
                }

                if (e.key === 'Escape') {
                    if (pendingAnnotation) setPendingAnnotation(null);
                    if (showDescModal) setShowDescModal(null);
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
    }, [navContext, router, isDrawing, pendingAnnotation, showDescModal, showApiKeyModal, mangaSlug]);

    const goToPrev = () => navContext.prev && router.push(`/${mangaSlug}/annotate/${navContext.prev.id}`);
    const goToNext = () => navContext.next && router.push(`/${mangaSlug}/annotate/${navContext.next.id}`);

    useEffect(() => {
        if (isAutoDetecting) return;

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
    }, [rectangle, pageId, isAutoDetecting]);

    const processNextBubble = useCallback(async () => {
        if (!imageRef.current) return;

        if (detectionQueueRef.current.length === 0) {
            setIsAutoDetecting(false);
            setQueueLength(0);
            setRectangle(null);
            toast.success("Détection automatique terminée !");
            return;
        }

        const nextBox = detectionQueueRef.current.shift();
        setQueueLength(detectionQueueRef.current.length);

        setRectangle(nextBox);

        const analysisData = { id_page: parseInt(pageId, 10), ...nextBox, texte_propose: '' };

        setPendingAnnotation(analysisData);
        setDebugImageUrl(null);

        if (preferLocalOCR && modelStatus === 'ready') {
            try {
                setLoadingText("Analyse Locale (Auto)...");
                setIsSubmitting(true);
                const requestId = Date.now();
                lastRequestId.current = requestId;

                const blob = await cropImage(imageRef.current, nextBox);
                runOcr(blob, requestId);
            } catch (err) {
                console.error(err);
                setIsSubmitting(false);
            }
        } else {
            handleRetryWithCloud(analysisData);
        }

    }, [pageId, preferLocalOCR, modelStatus, runOcr]);

    const handleExecuteDetection = async () => {
        if (!imageRef.current) return;

        try {
            setLoadingText("Détection des bulles...");
            setIsSubmitting(true);

            const response = await fetch(imageRef.current.src);
            const blob = await response.blob();

            const boxes = await detectBubbles(blob);

            if (boxes.length === 0) {
                toast.info("Aucune bulle détectée.");
                setIsSubmitting(false);
                return;
            }

            toast.success(`${boxes.length} bulles détectées !`);

            detectionQueueRef.current = boxes;
            setQueueLength(boxes.length);
            setIsAutoDetecting(true);

            setTimeout(() => {
                processNextBubble();
            }, 100);


        } catch (err) {
            console.error("Detection error:", err);
            toast.error("Erreur lors de la détection: " + err.message);
        } finally {
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
                if (error.message === "QUOTA_EXCEEDED") {
                    toast.error("Quota API Gemini dépassé !", {
                        description: "Votre clé a atteint sa limite gratuite (RPM/TPM). Réessayez dans une minute ou changez de clé."
                    });
                    return;
                }

                console.error("Cloud OCR Error:", error);

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
        if (pendingAnnotation) handleRetryWithCloud();
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

        const previousPage = { ...page };
        setPage(prev => ({
            ...prev,
            description: JSON.stringify(payload)
        }));
        setShowDescModal(false);
        setIsSavingDesc(true);

        try {
            await savePageDescription(pageId, payload);
            toast.success("Description et vecteurs enregistrés !");
        } catch (error) {

            setPage(previousPage);
            console.error(error);
            toast.error("Erreur lors de la sauvegarde.");
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
            if (error.message === "QUOTA_EXCEEDED") {
                toast.error("Quota API Gemini dépassé !", {
                    description: "Votre clé a atteint sa limite. Veuillez patienter."
                });
            } else {
                console.error("Erreur génération AI:", error);
                toast.error("Erreur lors de la génération par IA.", {
                    description: "Vérifiez votre clé API."
                });
            }
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
        if (isGuest || isMobile) return;
        setPendingAnnotation(bubble);
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

        if (newData) {
            setExistingBubbles(prev => {
                const exists = prev.find(b => b.id === newData.id);
                if (exists) {
                    return prev.map(b => b.id === newData.id ? { ...b, ...newData } : b);
                } else {
                    return [...prev, newData].sort((a, b) => a.order - b.order);
                }
            });
        }

        fetchBubbles();

        if (isAutoDetecting) {
            setTimeout(() => {
                processNextBubble();
            }, 300);
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

    const getContainerCoords = (event) => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const handleMouseDown = (event) => {
        if (isGuest || isMobile) return;
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
    if (!page) return null;

    const canEdit = !isGuest && (page.statut === 'not_started' || page.statut === 'in_progress');

    return (
        <div className="flex flex-col lg:flex-row h-[calc(100vh-64px)] bg-slate-50 overflow-hidden -mx-4 sm:-mx-8 -my-6 relative">
            {pageTitle && <title>{pageTitle}</title>}

            <div className="hidden lg:flex w-[280px] shrink-0 h-full flex-col border-r border-slate-200 bg-white z-40 relative shadow-sm">

                <div className="p-4 border-b border-slate-100 flex-none space-y-4 z-10">
                    <Link href={`/${mangaSlug}/dashboard`} className="inline-flex items-center text-[11px] font-bold text-slate-400 hover:text-slate-700 uppercase tracking-wider transition-colors">
                        <ArrowLeft size={12} className="mr-2" />
                        Retours
                    </Link>

                    <div className="flex items-center justify-between">
                        <div>
                            <div className="flex items-baseline gap-1.5">
                                <h2 className="text-xl font-black text-slate-900 tracking-tight">
                                    Ch.{page.chapitres?.numero}
                                </h2>
                                <span className="text-xs font-bold text-slate-400">Vol.{page.chapitres?.tomes?.numero}</span>
                            </div>
                            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mt-0.5">Page {page.numero_page} sur {chapterPages.length}</div>
                        </div>
                        <Badge variant="secondary" className="bg-slate-50 text-slate-600 border border-slate-200/60 font-bold px-2 py-0.5 text-[10px] uppercase tracking-wide">
                            {page.statut.replace(/_/g, ' ')}
                        </Badge>
                    </div>
                </div>

                <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden bg-slate-50/50">

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

                    <div className="flex-none p-3 rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col gap-3">
                        <div className="flex items-center justify-between pl-0.5">
                            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Moteur OCR</h3>
                            <button
                                onClick={() => !isGuest && toggleOcrPreference()}
                                disabled={isGuest}
                                className={cn(
                                    "relative inline-flex h-4 w-7 items-center rounded-full transition-colors focus:outline-none",
                                    preferLocalOCR ? "bg-emerald-500" : "bg-blue-500",
                                    isGuest && "opacity-50 cursor-not-allowed"
                                )}
                            >
                                <span className={cn(
                                    "inline-block h-3 w-3 transform rounded-full bg-white transition-transform shadow-sm",
                                    preferLocalOCR ? "translate-x-3.5" : "translate-x-0.5"
                                )} />
                            </button>
                        </div>

                        <div className="flex items-center gap-2.5 bg-slate-50 p-2 rounded-lg border border-slate-100/80">
                            <div className={cn("p-1.5 rounded-md", preferLocalOCR ? "bg-emerald-100/50 text-emerald-600" : "bg-blue-100/50 text-blue-600")}>
                                {preferLocalOCR ? <Cpu size={14} /> : <CloudLightning size={14} />}
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[11px] font-bold text-slate-800 leading-tight">{preferLocalOCR ? "Mode Local" : "Cloud API"}</span>
                                <span className="text-[9px] font-bold text-slate-400 mt-0.5">{preferLocalOCR ? "Inférence locale" : "API Gemini Distante"}</span>
                            </div>
                        </div>

                        {preferLocalOCR && (
                            <div className="">
                                {modelStatus === 'idle' && (
                                    <Button variant="outline" size="sm" onClick={loadModel} className="w-full h-8 text-[11px] font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-600">
                                        <Download size={12} className="mr-1.5" /> Charger le modèle
                                    </Button>
                                )}
                                {modelStatus === 'loading' && (
                                    <div className="p-2 bg-slate-50 rounded-lg border border-slate-100">
                                        <div className="flex justify-between text-[9px] font-bold text-slate-500 mb-1.5">
                                            <span>Installation...</span>
                                            <span>{Math.round(downloadProgress)}%</span>
                                        </div>
                                        <div className="h-1 w-full bg-slate-200 rounded-full overflow-hidden">
                                            <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${downloadProgress}%` }} />
                                        </div>
                                    </div>
                                )}
                                {modelStatus === 'ready' && (
                                    <div className="flex items-center justify-center gap-1.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 py-1.5 rounded-md border border-emerald-100/50">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm" /> Modèle opérationnel
                                    </div>
                                )}
                            </div>
                        )}

                        {!preferLocalOCR && !geminiKey && (
                            <div className="animate-in fade-in slide-in-from-top-1 duration-300 mt-1 flex flex-col gap-2 bg-amber-50 border border-amber-200/60 p-2.5 rounded-lg">
                                <div className="flex items-start gap-2">
                                    <div className="bg-amber-100 p-1 rounded-full shrink-0 mt-0.5">
                                        <Shield className="h-3 w-3 text-amber-600" />
                                    </div>
                                    <div className="text-[10px] leading-tight text-amber-800">
                                        <span className="font-bold block mb-0.5">Clé API Requise</span>
                                        Les appels Gemini Distants nécessitent votre clé. En l'absence de clé, l'extraction de texte sera ignorée.
                                    </div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => window.dispatchEvent(new Event('open-api-key-modal'))}
                                    className="h-7 text-[10px] font-bold text-amber-700 bg-amber-100/50 hover:bg-amber-100 border-amber-200 w-full"
                                >
                                    Configurer ma clé
                                </Button>
                            </div>
                        )}
                    </div>


                    <div className="flex-none p-3 rounded-xl border border-slate-200/60 bg-white shadow-sm flex flex-col gap-3">
                        <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-0.5">Scanner Vision</h3>

                        {detectionStatus === 'idle' && (
                            <Button variant="outline" size="sm" onClick={loadDetectionModel} className="w-full h-8 text-[11px] font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-600">
                                <Download size={12} className="mr-1.5" /> Activer l'IA Vision
                            </Button>
                        )}
                        {detectionStatus === 'loading' && (
                            <div className="p-2 bg-slate-50 rounded-lg border border-slate-100">
                                <div className="flex justify-between text-[9px] font-bold text-slate-500 mb-1.5">
                                    <span>Téléchargement...</span>
                                    <span>{Math.round(detectionProgress)}%</span>
                                </div>
                                <div className="h-1 w-full bg-slate-200 rounded-full overflow-hidden">
                                    <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${detectionProgress}%` }} />
                                </div>
                            </div>
                        )}
                        {detectionStatus === 'ready' && (
                            <Button
                                variant="default"
                                onClick={handleExecuteDetection}
                                disabled={isSubmitting || isAutoDetecting}
                                className="w-full h-8 bg-indigo-600 hover:bg-indigo-700 text-[11px] font-bold shadow-sm"
                            >
                                <Sparkles size={12} className={cn("mr-1.5", isAutoDetecting && "animate-pulse")} />
                                {isAutoDetecting ? `Analyse en cours (${queueLength})` : "Scanner la page"}
                            </Button>
                        )}
                    </div>
                </div>


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
            </div>


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
                )
                }

                {
                    page.commentaire_moderation && page.statut !== 'completed' && (
                        <div className="bg-red-50 border-b border-red-200 px-6 py-3 flex items-center gap-3 text-red-800 text-sm animate-in slide-in-from-top duration-300">
                            <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                                <X className="h-4 w-4 text-red-600" />
                            </div>
                            <div className="flex-1">
                                <p className="font-bold">Cette page a été refusée par la modération</p>
                                <p className="text-red-700/80 italic font-medium">"{page.commentaire_moderation}"</p>
                            </div>
                        </div>
                    )
                }





                <div className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-0">
                    <main className="flex-1 min-h-0 bg-slate-200/50 overflow-hidden flex items-center justify-center p-2 sm:p-4 relative cursor-default">
                        <div
                            ref={containerRef}
                            className={cn(
                                "relative inline-flex flex-col min-w-0 min-h-0 max-w-full max-h-full bg-white shadow-xl select-none",
                                canEdit ? "cursor-crosshair" : "cursor-default"
                            )}
                            style={{
                                aspectRatio: imageDimensions?.naturalWidth ? `${imageDimensions.naturalWidth} / ${imageDimensions.naturalHeight}` : 'auto'
                            }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp}
                            onMouseLeave={handleMouseUp}
                        >
                            <img
                                ref={imageRef}
                                src={getProxiedImageUrl(page.url_image, pageId, session?.access_token)}
                                crossOrigin="anonymous"
                                alt={`Page ${page.numero_page}`}
                                className="block w-full h-full object-contain pointer-events-none"
                                onLoad={(e) => setImageDimensions({
                                    width: e.target.offsetWidth,
                                    naturalWidth: e.target.naturalWidth,
                                    naturalHeight: e.target.naturalHeight
                                })}
                            />

                            {isSubmitting && (
                                <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-50 flex flex-col items-center justify-center text-slate-800 font-semibold">
                                    <Loader2 className="h-10 w-10 animate-spin mb-2 text-slate-900" />
                                    <span>{loadingText}</span>
                                </div>
                            )}

                            {rectangle && imageDimensions && (
                                <div
                                    style={{
                                        left: rectangle.x * (imageDimensions.width / imageDimensions.naturalWidth),
                                        top: rectangle.y * (imageDimensions.width / imageDimensions.naturalWidth),
                                        width: rectangle.w * (imageDimensions.width / imageDimensions.naturalWidth),
                                        height: rectangle.h * (imageDimensions.width / imageDimensions.naturalWidth),
                                    }}
                                    className={cn(
                                        "absolute border-2 border-dashed transition-all duration-300 z-30 pointer-events-none",
                                        isAutoDetecting ? "border-indigo-500 bg-indigo-500/10" : "border-red-500 bg-red-500/10"
                                    )}
                                />
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

                    <aside className="w-full lg:w-[380px] bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col h-[40vh] lg:h-full overflow-hidden z-10 shadow-lg shrink-0">
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
            </div>

            <Dialog
                open={!!pendingAnnotation && !isSubmitting}
                onOpenChange={(open) => {
                    if (!open) {
                        if (!isSubmitting) {
                            if (isAutoDetecting) {
                                setIsAutoDetecting(false);
                                toast.info("Détection automatique arrêtée.");
                            }
                            setPendingAnnotation(null);
                            setDebugImageUrl(null);
                            setRectangle(null);
                        }
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
                                            setDebugImageUrl(null);

                                            if (isAutoDetecting) {
                                                setTimeout(() => processNextBubble(), 100);
                                            } else {
                                                setRectangle(null);
                                            }
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
        </div >
    );
}
