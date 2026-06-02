"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, updatePageStatus, reorderBubbles, savePageDescription, getMetadataSuggestions, getPages } from '@/lib/api';
import { analyzeBubble, generatePageDescription, generateGeminiEmbedding, generateOneShotBubbles } from '@/lib/geminiClient';
import { generateMimoOneShotBubbles } from '@/lib/mimoClient';
import ApiKeyForm from '@/components/ApiKeyForm';
import { useAuth } from '@/context/AuthContext';
import { OCR_MODELS } from '@/context/WorkerContext';
import { useManga } from '@/context/MangaContext';
import { arrayMove } from '@dnd-kit/sortable';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import { useAnnotationOCR } from '@/hooks/useAnnotationOCR';
import { useAnnotationDetection } from '@/hooks/useAnnotationDetection';
import { useAnnotationMetadata } from '@/hooks/useAnnotationMetadata';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
import { getProxiedImageUrl } from '@/lib/utils';
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowLeft, Send, X, Shield, FileText } from "lucide-react";
import { toast } from "sonner";
import AnnotateLeftSidebar from '@/components/AnnotateLeftSidebar';
import AnnotateCanvas from '@/components/AnnotateCanvas';
import AnnotateAnnotationSidebar from '@/components/AnnotateAnnotationSidebar';
import AnnotateEditorDialog from '@/components/AnnotateEditorDialog';
import AnnotateMetadataModal from '@/components/AnnotateMetadataModal';

const PAGE_STATUSES = [
    { value: 'not_started', label: 'Non commencée' },
    { value: 'in_progress', label: 'En cours' },
    { value: 'pending_review', label: 'En revue' },
    { value: 'completed', label: 'Validée' },
];

function imageElementToJpegBlob(img) {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
}

async function runModalPoneglyph(imageBlob) {
    const response = await fetch('/api/poneglyph_one_shot', {
        method: 'POST',
        body: imageBlob
    });

    if (!response.ok) throw new Error("Erreur API Poneglyph");
    return response.json();
}

export default function AnnotatePage() {
    const { user, session, isGuest, role } = useAuth();
    const params = useParams();
    const searchParams = useSearchParams();
    const fromSearch = searchParams.get('from') === 'search';
    const paramsPageId = params?.pageId;
    const [pageId, setPageId] = useState(paramsPageId);
    const { mangaSlug, currentManga } = useManga();

    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [error, setError] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isUpdatingPageStatus, setIsUpdatingPageStatus] = useState(false);
    const [loadingText, setLoadingText] = useState("Analyse en cours...");
    const [pendingAnnotation, setPendingAnnotation] = useState(null);
    const [isOneShotLoading, setIsOneShotLoading] = useState(false);
    const [isMimoLoading, setIsMimoLoading] = useState(false);
    const [isPoneglyphLoading, setIsPoneglyphLoading] = useState(false);
    const [poneglyphRunMode, setPoneglyphRunMode] = useState(null);
    const [rectangle, setRectangle] = useState(null);
    const [imageDimensions, setImageDimensions] = useState(null);
    const [ocrSource, setOcrSource] = useState(null);
    const [debugImageUrl, setDebugImageUrl] = useState(null);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [showDescModal, setShowDescModal] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const canEdit = page && !isGuest && (role === 'Admin' || role === 'Modo') && (page.statut === 'not_started' || page.statut === 'in_progress');

    const containerRef = useRef(null);
    const imageRef = useRef(null);
    const tauriLocalOcr = useTauriLocalOcrContext();

    const [chapterPages, setChapterPages] = useState([]);
    const [navContext, setNavContext] = useState({ prev: null, next: null });
    const [isMobile, setIsMobile] = useState(false);

    const chapterPagesRef = useRef([]);
    chapterPagesRef.current = chapterPages;

    const pageIdRef = useRef(pageId);
    pageIdRef.current = pageId;

    const navGenerationRef = useRef(0);

    useEffect(() => {
        if (paramsPageId && String(paramsPageId) !== String(pageIdRef.current)) {
            setPageId(paramsPageId);
        }
    }, [paramsPageId]);

    useEffect(() => {
        const handlePopState = () => {
            const pathParts = window.location.pathname.split('/');
            const urlPageId = pathParts[pathParts.length - 1];
            if (urlPageId && String(urlPageId) !== String(pageIdRef.current)) {
                navGenerationRef.current += 1;
                setPageId(urlPageId);
                setPendingAnnotation(null);
                setRectangle(null);
                setIsModalOpen(false);
                setDebugImageUrl(null);
                setError(null);
            }
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    const navigateToPage = useCallback((newPageId) => {
        navGenerationRef.current += 1;
        setPageId(newPageId);
        window.history.pushState({}, '', `/${mangaSlug}/annotate/${newPageId}`);
        setPendingAnnotation(null);
        setRectangle(null);
        setIsModalOpen(false);
        setDebugImageUrl(null);
        setError(null);
        const pages = chapterPagesRef.current;
        if (pages.length > 0) {
            const currentIndex = pages.findIndex(p => p.id === parseInt(newPageId));
            setNavContext({
                prev: currentIndex > 0 ? pages[currentIndex - 1] : null,
                next: currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null
            });
        }
    }, [mangaSlug]);

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
        runBackgroundOcr, ocrResults, handleRetryWithCloud
    } = useAnnotationOCR({
        imageRef, pageId, rectangle, pendingAnnotation, setPendingAnnotation,
        setIsSubmitting, setLoadingText, setIsModalOpen, setOcrSource,
        setDebugImageUrl, setShowApiKeyModal
    });

    const {
        isAutoDetecting, setIsAutoDetecting, queueLength, detectionStatus,
        loadDetectionModel, detectionProgress, downloadStats, handleExecuteDetection,
        processNextBubble, detectBubbles
    } = useAnnotationDetection({
        imageRef, pageId, setRectangle, setPendingAnnotation, setDebugImageUrl,
        runLocalOcr, runBackgroundOcr, setIsSubmitting, setLoadingText
    });

    const {
        isDrawing, startPoint, endPoint, mousePos, isShiftPressed,
        hoveredBubble, setHoveredBubble, handleMouseDown, handleMouseMove,
        handleMouseUp, handleInteractionStart
    } = useAnnotationInteractions({
        containerRef, imageRef, imageDimensions, existingBubbles, setExistingBubbles,
        pendingAnnotation, setPendingAnnotation, setRectangle, canEdit, isMobile,
        pageStatus: page?.statut, isSubmitting, showApiKeyModal, showDescModal
    });

    const fetchBubbles = useCallback(() => {
        if (pageId && (session?.access_token || isGuest)) {
            const gen = navGenerationRef.current;
            getBubblesForPage(pageId)
                .then(response => {
                    if (gen !== navGenerationRef.current) return;
                    const sortedBubbles = response.data.sort((a, b) => a.order - b.order);
                    setExistingBubbles(sortedBubbles);
                })
                .catch(error => console.error(error));
        }
    }, [pageId, session, isGuest]);

    useEffect(() => {
        if (pageId && (session?.access_token || isGuest)) {
            const gen = navGenerationRef.current;
            getPageById(pageId)
                .then(response => {
                    if (gen !== navGenerationRef.current) return;
                    setPage(response.data);
                    if (response.data.id_chapitre) {
                        getPages(response.data.id_chapitre)
                            .then(pagesRes => {
                                if (gen !== navGenerationRef.current) return;
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
                .catch(() => {
                    if (gen === navGenerationRef.current) setError("Impossible de charger la page.");
                });
            fetchBubbles();
        }
    }, [pageId, session?.access_token, isGuest, fetchBubbles]);

    useEffect(() => {
        if (detectionStatus === 'idle') {
            loadDetectionModel();
        }
    }, [detectionStatus, loadDetectionModel]);

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
                    if (!isGuest && navContext.prev) navigateToPage(navContext.prev.id);
                    break;
                case 'ArrowRight':
                    if (!isGuest && navContext.next) navigateToPage(navContext.next.id);
                    break;
                case 'Escape':
                    if (isDrawing) { /* dealt with in hook but can be here too */ }
                    if (pendingAnnotation) setPendingAnnotation(null);
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [navContext, navigateToPage, pendingAnnotation, showDescModal, showApiKeyModal, mangaSlug, isDrawing, isGuest]);

    const goToPrev = useCallback(() => navContext.prev && navigateToPage(navContext.prev.id), [navContext.prev, navigateToPage]);
    const goToNext = useCallback(() => navContext.next && navigateToPage(navContext.next.id), [navContext.next, navigateToPage]);

    useEffect(() => {
        if (isAutoDetecting) return;
        if (rectangle && imageRef.current) {
            const analysisData = {
                id: `manual-${Date.now()}`,
                id_page: parseInt(pageId, 10), 
                ...rectangle, 
                texte_propose: '' 
            };
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
        if (!canEdit || isMobile) return;
        setPendingAnnotation(bubble);
        setIsModalOpen(true);
    };

    const handleDeleteBubble = async (bubbleId) => {
        if (isGuest || (isMobile && role !== 'Admin')) return;
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

    const handleSuccess = (newData, tempId = null) => {
        const isOptimistic = !!newData?.isOptimistic;
        const isBackgroundResult = !!tempId;

        if (isOptimistic) {
            setPendingAnnotation(null);
            setDebugImageUrl(null);
            setIsModalOpen(false);
            if (isAutoDetecting) {
                setTimeout(() => processNextBubble(), 100);
            } else {
                setRectangle(null);
            }
        }

        if (newData) {
            setExistingBubbles(prev => {
                const results = [...prev];
                const idx = results.findIndex(b => b.id === newData.id || (tempId && b.id === tempId));

                if (idx !== -1) {
                    results[idx] = { ...results[idx], ...newData };
                    if (isBackgroundResult) results[idx].isOptimistic = false;
                } else if (!isBackgroundResult) {
                    results.push(newData);
                }

                return results.sort((a, b) => a.order - b.order);
            });
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

    const handlePageStatusChange = async (statut) => {
        if (role !== 'Admin' || !pageId || statut === page?.statut) return;

        setIsUpdatingPageStatus(true);
        try {
            const response = await updatePageStatus(pageId, statut);
            setPage(response.data);
            toast.success("Statut de la page mis à jour.");
            window.location.reload();
        } catch (error) {
            toast.error("Erreur lors du changement de statut.");
        } finally {
            setIsUpdatingPageStatus(false);
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

    const handleOneShot = async () => {
        if (!imageRef.current) return;
        const key = geminiKey || localStorage.getItem('google_api_key');
        if (!key) {
            toast.error("Clé API Google requise pour l'extraction One-Shot.");
            setShowApiKeyModal(true);
            return;
        }

        setIsOneShotLoading(true);
        try {
            let yoloPromise = Promise.resolve(null);
            if (detectionStatus === 'ready') {
                yoloPromise = fetch(imageRef.current.src)
                    .then(r => r.blob())
                    .then(b => detectBubbles(b))
                    .catch(e => {
                        console.error('YOLO Failed', e);
                        return null;
                    });
            }

            const [result, yoloBoxes] = await Promise.all([
                generateOneShotBubbles(imageRef.current, key),
                yoloPromise
            ]);

            if (!result || !result.data || !Array.isArray(result.data)) {
                throw new Error("Format de réponse invalide.");
            }

            const h = imageRef.current.naturalHeight;
            const w = imageRef.current.naturalWidth;
            
            const newBubblesConfig = result.data.reduce((acc, idx) => {
                const [ymin, xmin, ymax, xmax] = idx.pos;
                let geminiBox = {
                    id_page: parseInt(pageId, 10),
                    x: Math.round((xmin / 1000) * w),
                    y: Math.round((ymin / 1000) * h),
                    w: Math.round(((xmax - xmin) / 1000) * w),
                    h: Math.round(((ymax - ymin) / 1000) * h),
                    texte_propose: idx.content
                };

                if (detectionStatus === 'ready') {
                    // YOLO is loaded, so we enforce intersection
                    const boxes = yoloBoxes || [];
                    let bestYoloBox = null;
                    let bestIou = 0;
                    for (const yBox of boxes) {
                        const x1 = Math.max(geminiBox.x, yBox.x);
                        const y1 = Math.max(geminiBox.y, yBox.y);
                        const x2 = Math.min(geminiBox.x + geminiBox.w, yBox.x + yBox.w);
                        const y2 = Math.min(geminiBox.y + geminiBox.h, yBox.y + yBox.h);

                        if (x2 < x1 || y2 < y1) continue;
                        const intersection = (x2 - x1) * (y2 - y1);
                        const areaGemini = geminiBox.w * geminiBox.h;
                        const areaYolo = yBox.w * yBox.h;
                        const iou = intersection / (areaGemini + areaYolo - intersection);

                        if (iou > 0.1 && iou > bestIou) {
                            bestIou = iou;
                            bestYoloBox = yBox;
                        }
                    }

                    if (bestYoloBox) {
                        geminiBox.x = Math.round(bestYoloBox.x);
                        geminiBox.y = Math.round(bestYoloBox.y);
                        geminiBox.w = Math.round(bestYoloBox.w);
                        geminiBox.h = Math.round(bestYoloBox.h);
                        acc.push(geminiBox);
                    }
                    // If no intersection, we ignore it (inversement logic)
                } else {
                    // YOLO not active, keep original Gemini box
                    acc.push(geminiBox);
                }

                return acc;
            }, []);

            if (newBubblesConfig.length === 0) {
                toast.error("Aucune bulle détectée.");
                setIsOneShotLoading(false);
                return;
            }

            toast.info(`Création de ${newBubblesConfig.length} bulles en cours...`);
            
            const createdBubbles = [];
            const { createBubble } = await import('@/lib/api');
            for (const bubbleConfig of newBubblesConfig) {
                try {
                    const res = await createBubble(bubbleConfig);
                    createdBubbles.push(res.data);
                } catch (e) {
                    console.error("Erreur création bulle One-Shot", e);
                }
            }
            
            if (createdBubbles.length > 0) {
                setExistingBubbles(prev => {
                    const combined = [...prev, ...createdBubbles];
                    return combined.sort((a, b) => a.order - b.order);
                });
                toast.success(`${createdBubbles.length} bulles créées avec succès.`);
            } else {
                toast.error("Échec de la création des bulles.");
            }
        } catch (error) {
            console.error(error);
            toast.error("Service d'extraction indisponible ou erreur d'API.");
        } finally {
            setIsOneShotLoading(false);
        }
    };

    const handleOneShotMimo = async () => {
        if (!imageRef.current) return;
        const key = localStorage.getItem('mimo_api_key');
        if (!key) {
            toast.error("Clé API MiMo requise pour l'extraction One-Shot.");
            setShowApiKeyModal(true);
            return;
        }

        setIsMimoLoading(true);
        try {
            let yoloPromise = Promise.resolve(null);
            if (detectionStatus === 'ready') {
                yoloPromise = fetch(imageRef.current.src)
                    .then(r => r.blob())
                    .then(b => detectBubbles(b))
                    .catch(e => {
                        console.error('YOLO Failed', e);
                        return null;
                    });
            }

            const [result, yoloBoxes] = await Promise.all([
                generateMimoOneShotBubbles(imageRef.current, key),
                yoloPromise
            ]);

            if (!result || !result.data || !Array.isArray(result.data)) {
                throw new Error("Format de réponse invalide.");
            }

            const h = imageRef.current.naturalHeight;
            const w = imageRef.current.naturalWidth;

            const newBubblesConfig = result.data.reduce((acc, idx) => {
                const [ymin, xmin, ymax, xmax] = idx.pos;
                let mimoBox = {
                    id_page: parseInt(pageId, 10),
                    x: Math.round((xmin / 1000) * w),
                    y: Math.round((ymin / 1000) * h),
                    w: Math.round(((xmax - xmin) / 1000) * w),
                    h: Math.round(((ymax - ymin) / 1000) * h),
                    texte_propose: idx.content
                };

                if (detectionStatus === 'ready') {
                    const boxes = yoloBoxes || [];
                    let bestYoloBox = null;
                    let bestIou = 0;
                    for (const yBox of boxes) {
                        const x1 = Math.max(mimoBox.x, yBox.x);
                        const y1 = Math.max(mimoBox.y, yBox.y);
                        const x2 = Math.min(mimoBox.x + mimoBox.w, yBox.x + yBox.w);
                        const y2 = Math.min(mimoBox.y + mimoBox.h, yBox.y + yBox.h);

                        if (x2 < x1 || y2 < y1) continue;
                        const intersection = (x2 - x1) * (y2 - y1);
                        const areaMimo = mimoBox.w * mimoBox.h;
                        const areaYolo = yBox.w * yBox.h;
                        const iou = intersection / (areaMimo + areaYolo - intersection);

                        if (iou > 0.1 && iou > bestIou) {
                            bestIou = iou;
                            bestYoloBox = yBox;
                        }
                    }

                    if (bestYoloBox) {
                        mimoBox.x = Math.round(bestYoloBox.x);
                        mimoBox.y = Math.round(bestYoloBox.y);
                        mimoBox.w = Math.round(bestYoloBox.w);
                        mimoBox.h = Math.round(bestYoloBox.h);
                        acc.push(mimoBox);
                    }
                } else {
                    acc.push(mimoBox);
                }

                return acc;
            }, []);

            if (newBubblesConfig.length === 0) {
                toast.error("Aucune bulle détectée.");
                setIsMimoLoading(false);
                return;
            }

            toast.info(`Création de ${newBubblesConfig.length} bulles en cours...`);

            const createdBubbles = [];
            const { createBubble } = await import('@/lib/api');
            for (const bubbleConfig of newBubblesConfig) {
                try {
                    const res = await createBubble(bubbleConfig);
                    createdBubbles.push(res.data);
                } catch (e) {
                    console.error("Erreur création bulle MiMo", e);
                }
            }

            if (createdBubbles.length > 0) {
                setExistingBubbles(prev => {
                    const combined = [...prev, ...createdBubbles];
                    return combined.sort((a, b) => a.order - b.order);
                });
                toast.success(`${createdBubbles.length} bulles créées avec succès.`);
            } else {
                toast.error("Échec de la création des bulles.");
            }
        } catch (error) {
            console.error(error);
            if (error.message === "QUOTA_EXCEEDED") {
                toast.error("Quota API MiMo dépassé !", {
                    description: "Réessayez dans une minute ou vérifiez votre clé."
                });
            } else {
                toast.error("Service MiMo indisponible ou erreur d'API.");
            }
        } finally {
            setIsMimoLoading(false);
        }
    };

    const handleOneShotPoneglyph = async ({ preferLocal = false } = {}) => {
        if (!imageRef.current) return;

        const runMode = preferLocal ? 'local' : 'modal';
        setIsPoneglyphLoading(true);
        setPoneglyphRunMode(runMode);
        try {
            if (preferLocal && !tauriLocalOcr.canRunLocalOcr) {
                throw new Error("Le modele BBox local doit etre charge avant de lancer le one-shot local.");
            }

            let yoloPromise = Promise.resolve(null);
            if (detectionStatus === 'ready') {
                yoloPromise = fetch(imageRef.current.src)
                    .then(r => r.blob())
                    .then(b => detectBubbles(b))
                    .catch(e => {
                        console.error('YOLO Failed', e);
                        return null;
                    });
            }

            const imageBlob = await imageElementToJpegBlob(imageRef.current);
            if (!imageBlob) throw new Error("Impossible de convertir l'image.");

            const extractionPromise = (async () => {
                if (preferLocal) {
                    const localResult = await tauriLocalOcr.runLocalOcrBlob(imageBlob);
                    if (localResult?.elapsed_ms) {
                        toast.success(`OCR local termine en ${localResult.elapsed_ms} ms.`);
                    }
                    return localResult;
                }

                return runModalPoneglyph(imageBlob);
            })();

            const [apiResponse, yoloBoxes] = await Promise.all([
                extractionPromise,
                yoloPromise
            ]);

            if (apiResponse.error) {
                throw new Error(apiResponse.error);
            }

            if (!apiResponse.bubbles || !Array.isArray(apiResponse.bubbles)) {
                throw new Error("Format de réponse invalide.");
            }

            const h = imageRef.current.naturalHeight;
            const w = imageRef.current.naturalWidth;

            const newBubblesConfig = apiResponse.bubbles.map((bubble) => {
                const [x1, y1, x2, y2] = bubble.bbox;
                let poneglyphBox = {
                    id_page: parseInt(pageId, 10),
                    x: Math.round((x1 / 1000) * w),
                    y: Math.round((y1 / 1000) * h),
                    w: Math.round(((x2 - x1) / 1000) * w),
                    h: Math.round(((y2 - y1) / 1000) * h),
                    texte_propose: bubble.content
                };

                if (detectionStatus === 'ready' && yoloBoxes) {
                    let bestYoloBox = null;
                    let bestIou = 0;
                    for (const yBox of yoloBoxes) {
                        const ix1 = Math.max(poneglyphBox.x, yBox.x);
                        const iy1 = Math.max(poneglyphBox.y, yBox.y);
                        const ix2 = Math.min(poneglyphBox.x + poneglyphBox.w, yBox.x + yBox.w);
                        const iy2 = Math.min(poneglyphBox.y + poneglyphBox.h, yBox.y + yBox.h);

                        if (ix2 < ix1 || iy2 < iy1) continue;
                        const intersection = (ix2 - ix1) * (iy2 - iy1);
                        const areaP = poneglyphBox.w * poneglyphBox.h;
                        const areaY = yBox.w * yBox.h;
                        const iou = intersection / (areaP + areaY - intersection);

                        if (iou > 0.05 && iou > bestIou) {
                            bestIou = iou;
                            bestYoloBox = yBox;
                        }
                    }

                    if (bestYoloBox) {
                        poneglyphBox.x = Math.round(bestYoloBox.x);
                        poneglyphBox.y = Math.round(bestYoloBox.y);
                        poneglyphBox.w = Math.round(bestYoloBox.w);
                        poneglyphBox.h = Math.round(bestYoloBox.h);
                    }
                }

                return poneglyphBox;
            });

            if (newBubblesConfig.length === 0) {
                toast.error("Aucune bulle détectée.");
                setIsPoneglyphLoading(false);
                return;
            }

            toast.info(`Création de ${newBubblesConfig.length} bulles Poneglyph...`);

            const createdBubbles = [];
            const { createBubble } = await import('@/lib/api');
            for (const bubbleConfig of newBubblesConfig) {
                try {
                    const res = await createBubble(bubbleConfig);
                    createdBubbles.push(res.data);
                } catch (e) {
                    console.error("Erreur création bulle Poneglyph", e);
                }
            }

            if (createdBubbles.length > 0) {
                setExistingBubbles(prev => {
                    const combined = [...prev, ...createdBubbles];
                    return combined.sort((a, b) => a.order - b.order);
                });
                toast.success(`${createdBubbles.length} bulles Poneglyph créées !`);
            } else {
                toast.error("Échec de la création des bulles.");
            }
        } catch (error) {
            console.error(error);
            toast.error(`${runMode === 'local' ? 'OCR local Poneglyph' : 'Service Modal Poneglyph'} indisponible : ${error.message}`);
        } finally {
            setIsPoneglyphLoading(false);
            setPoneglyphRunMode(null);
        }
    };

    const handleOneShotLocalPoneglyph = () => {
        if (!tauriLocalOcr.canRunLocalOcr) {
            const reason = !tauriLocalOcr.isTauri
                ? "App desktop non detectee."
                : tauriLocalOcr.isDownloadingLocalModel
                        ? "Telechargement du modele BBox local en cours."
                        : !tauriLocalOcr.localModelStatus?.installed
                            ? "Telechargez le modele BBox local d'abord."
                            : !tauriLocalOcr.localModelStatus?.ready
                                ? "Chargez le modele BBox local en VRAM d'abord."
                            : "OCR local indisponible.";
            toast.error(reason);
            return;
        }
        return handleOneShotPoneglyph({ preferLocal: true });
    };

    if (error) return <div className="p-8 text-red-500">{error}</div>;
    if (!page) return null;

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
                role={role}
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
                downloadStats={downloadStats}
                handleExecuteDetection={handleExecuteDetection}
                isSubmitting={isSubmitting}
                isAutoDetecting={isAutoDetecting}
                queueLength={queueLength}
                setShowDescModal={setShowDescModal}
                setShowApiKeyModal={setShowApiKeyModal}
                handleSubmitPage={handleSubmitPage}
                handlePageStatusChange={handlePageStatusChange}
                isUpdatingPageStatus={isUpdatingPageStatus}
                handleOneShot={handleOneShot}
                isOneShotLoading={isOneShotLoading}
                handleOneShotMimo={handleOneShotMimo}
                isMimoLoading={isMimoLoading}
                handleOneShotPoneglyph={handleOneShotPoneglyph}
                isPoneglyphLoading={isPoneglyphLoading}
                poneglyphRunMode={poneglyphRunMode}
                handleOneShotLocalPoneglyph={handleOneShotLocalPoneglyph}
                isTauri={tauriLocalOcr.isTauri}
                isCheckingLocalConnection={tauriLocalOcr.isCheckingLocalConnection}
                localModelStatus={tauriLocalOcr.localModelStatus}
                localTextModelStatus={tauriLocalOcr.localTextModelStatus}
                localSuryaModelStatus={tauriLocalOcr.localSuryaModelStatus}
                localHealth={tauriLocalOcr.localHealth}
                localConnectionState={tauriLocalOcr.localConnectionState}
                isDownloadingLocalModel={tauriLocalOcr.isDownloadingLocalModel}
                isDownloadingLocalTextModel={tauriLocalOcr.isDownloadingLocalTextModel}
                isDownloadingLocalSuryaModel={tauriLocalOcr.isDownloadingLocalSuryaModel}
                localDownloadState={tauriLocalOcr.localDownloadState}
                localTextDownloadState={tauriLocalOcr.localTextDownloadState}
                localSuryaDownloadState={tauriLocalOcr.localSuryaDownloadState}
                localDownloadProgress={tauriLocalOcr.localDownloadProgress}
                localTextDownloadProgress={tauriLocalOcr.localTextDownloadProgress}
                localSuryaDownloadProgress={tauriLocalOcr.localSuryaDownloadProgress}
                isLoadingLocalModel={tauriLocalOcr.isLoadingLocalModel}
                isLoadingLocalTextModel={tauriLocalOcr.isLoadingLocalTextModel}
                isLoadingLocalSuryaModel={tauriLocalOcr.isLoadingLocalSuryaModel}
                isLocalInferencing={tauriLocalOcr.isLocalInferencing}
                localError={tauriLocalOcr.localError}
                canRunLocalOcr={tauriLocalOcr.canRunLocalOcr}
                canRunLocalTextOcr={tauriLocalOcr.canRunLocalTextOcr}
                canRunLocalSuryaOcr={tauriLocalOcr.canRunLocalSuryaOcr}
                downloadLocalModel={tauriLocalOcr.downloadLocalModel}
                downloadLocalTextModel={tauriLocalOcr.downloadLocalTextModel}
                downloadLocalSuryaModel={tauriLocalOcr.downloadLocalSuryaModel}
                loadLocalModel={tauriLocalOcr.loadLocalModel}
                loadLocalTextModel={tauriLocalOcr.loadLocalTextModel}
                loadLocalSuryaModel={tauriLocalOcr.loadLocalSuryaModel}
                refreshLocalDiagnostics={tauriLocalOcr.refreshLocalDiagnostics}
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
                        {!isGuest && (role === 'Admin' || role === 'Modo') && (
                            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setShowDescModal(true)}>
                                <FileText size={16} />
                            </Button>
                        )}
                        <Button variant="default" size="sm" className="h-9" disabled={page.statut === 'pending_review' || page.statut === 'completed' || isGuest || role === 'User'} onClick={handleSubmitPage}>
                            <Send size={14} className="mr-2" /> Soumettre
                        </Button>
                    </div>
                </header>

                {!isGuest && role === 'Admin' && (
                    <div className="lg:hidden border-b border-slate-200 bg-white px-4 py-3">
                        <Select value={page.statut} onValueChange={handlePageStatusChange} disabled={isUpdatingPageStatus}>
                            <SelectTrigger className="w-full h-9 bg-white border-slate-200 text-[12px] font-bold text-slate-700">
                                <SelectValue placeholder="Choisir un état" />
                            </SelectTrigger>
                            <SelectContent>
                                {PAGE_STATUSES.map(status => (
                                    <SelectItem key={status.value} value={status.value}>
                                        {status.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {isGuest && (
                    <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center justify-center gap-2 text-amber-800 text-sm font-medium">
                        <Shield className="h-4 w-4" />
                        Mode Visiteur : Modification et navigation limitées. Connectez-vous pour tout débloquer.
                    </div>
                )}

                {page.commentaire_moderation && page.statut !== 'completed' && (
                    <div className="bg-red-50 border-b border-red-200 px-6 py-3 flex items-center gap-3 text-red-800 text-sm animate-in slide-in-from-top duration-300">
                        <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                            <X className="h-4 w-4 text-red-600" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold">Cette page a été refusée par la modération</p>
                            <p className="text-red-700/80 italic font-medium">&quot;{page.commentaire_moderation}&quot;</p>
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
                        role={role}
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
                        <DialogTitle>Configuration API</DialogTitle>
                        <DialogDescription>Gérez vos clés API.</DialogDescription>
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
