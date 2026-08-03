"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, updatePageStatus, reorderBubbles, savePageDescription, getMetadataSuggestions, getPages } from '@/lib/api';
import { analyzeBubble, generatePageDescription, generateGeminiEmbedding, generateOneShotBubbles } from '@/lib/geminiClient';
import ApiKeyForm from '@/components/ApiKeyForm';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
import { arrayMove } from '@dnd-kit/sortable';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import { useAnnotationOCR } from '@/hooks/useAnnotationOCR';
import { useAnnotationDetection } from '@/hooks/useAnnotationDetection';
import { useAnnotationMetadata } from '@/hooks/useAnnotationMetadata';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
import { getProxiedImageUrl } from '@/lib/utils';
import { fetchOriginalPageImage } from '@/lib/pageImageClient';
import { capitalizeOcrSentenceStarts } from '@/lib/ocr-utils';
import { postOcrImage } from '@/lib/ocrProxyClient';
import { canCreateBubble, canEditBubble, canReorderBubbles } from '@/lib/bubblePermissions';
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowLeft, Send, X, Shield, FileText, Loader2 } from "lucide-react";
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

const PREFETCH_BEHIND_COUNT = 1;
const PREFETCH_AHEAD_COUNT = 2;

function normalizePageId(id) {
    return id == null ? null : String(id);
}

function sortBubblesForAnnotation(bubbles = []) {
    return [...bubbles].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function unwrapApiData(value) {
    return value?.data ?? value;
}

function getNearbyChapterPages(
    chapterPages,
    currentPageId,
    behindCount = PREFETCH_BEHIND_COUNT,
    aheadCount = PREFETCH_AHEAD_COUNT
) {
    const currentIndex = chapterPages.findIndex(p => normalizePageId(p.id) === normalizePageId(currentPageId));
    if (currentIndex === -1) return [];
    return chapterPages.slice(
        Math.max(0, currentIndex - behindCount),
        currentIndex + aheadCount + 1
    ).filter(p => normalizePageId(p.id) !== normalizePageId(currentPageId));
}

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
    const response = await postOcrImage('/api/poneglyph_one_shot', imageBlob);

    if (!response.ok) throw new Error("Erreur API Poneglyph-BBox");
    return response.json();
}

export default function AnnotatePage() {
    const { user, session, isGuest, role } = useAuth();
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const fromSearch = searchParams.get('from') === 'search';
    const detectionDebugEnabled = searchParams.get('debug') === '1';
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
    const [isPoneglyphLoading, setIsPoneglyphLoading] = useState(false);
    const [poneglyphRunMode, setPoneglyphRunMode] = useState(null);
    const [rectangle, setRectangle] = useState(null);
    const [imageDimensions, setImageDimensions] = useState(null);
    const [ocrSource, setOcrSource] = useState(null);
    const [debugImageUrl, setDebugImageUrl] = useState(null);
    const [originalImageUrl, setOriginalImageUrl] = useState(null);
    const [detectionDebugData, setDetectionDebugData] = useState(null);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [showDescModal, setShowDescModal] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const canEdit = canCreateBubble({ page, user, role, isGuest });

    const containerRef = useRef(null);
    const imageRef = useRef(null);
    const tauriLocalOcr = useTauriLocalOcrContext();

    const [chapterPages, setChapterPages] = useState([]);
    const [navContext, setNavContext] = useState({ prev: null, next: null });
    const [isMobile, setIsMobile] = useState(false);
    const canReorder = canReorderBubbles({ page, user, role, isGuest, bubbles: existingBubbles });
    const canEditExistingBubble = useCallback(
        (bubble) => canEditBubble({ page, user, role, isGuest, bubble }),
        [page, user, role, isGuest]
    );

    const chapterPagesRef = useRef([]);
    chapterPagesRef.current = chapterPages;

    const pageIdRef = useRef(pageId);
    pageIdRef.current = pageId;

    const navGenerationRef = useRef(0);
    const pageCacheRef = useRef(new Map());
    const bubbleCacheRef = useRef(new Map());
    const imageBlobCacheRef = useRef(new Map());

    useEffect(() => {
        imageBlobCacheRef.current.clear();
    }, [session?.access_token]);

    useEffect(() => {
        if (paramsPageId && String(paramsPageId) !== String(pageIdRef.current)) {
            setPageId(paramsPageId);
        }
    }, [paramsPageId]);

    useEffect(() => {
        if (!detectionDebugEnabled) {
            setDetectionDebugData(null);
        }
    }, [detectionDebugEnabled]);

    useEffect(() => {
        const handlePopState = () => {
            const pathParts = window.location.pathname.split('/');
            const urlPageId = pathParts[pathParts.length - 1];
            if (urlPageId && String(urlPageId) !== String(pageIdRef.current)) {
                navGenerationRef.current += 1;
                setPageId(urlPageId);
                setImageDimensions(null);
                setPendingAnnotation(null);
                setRectangle(null);
                setIsModalOpen(false);
                setDebugImageUrl(null);
                setDetectionDebugData(null);
                setError(null);
            }
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    const navigateToPage = useCallback((newPageId) => {
        navGenerationRef.current += 1;
        setPageId(newPageId);
        setImageDimensions(null);
        window.history.pushState({}, '', `/${mangaSlug}/annotate/${newPageId}`);
        setPendingAnnotation(null);
        setRectangle(null);
        setIsModalOpen(false);
        setDebugImageUrl(null);
        setDetectionDebugData(null);
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

    const cacheBubblesForPage = useCallback((targetPageId, bubbles) => {
        const cacheKey = normalizePageId(targetPageId);
        if (!cacheKey) return;
        bubbleCacheRef.current.set(cacheKey, sortBubblesForAnnotation(bubbles));
    }, []);

    const getOriginalPageBlob = useCallback((targetPageId) => {
        const token = session?.access_token;
        const cacheKey = `${normalizePageId(targetPageId)}:${token || 'none'}`;
        if (!token) return Promise.reject(new Error('Session manquante'));

        const cached = imageBlobCacheRef.current.get(cacheKey);
        if (cached instanceof Blob) return Promise.resolve(cached);
        if (cached) return cached;

        const request = fetchOriginalPageImage(targetPageId, token)
            .then((blob) => {
                imageBlobCacheRef.current.set(cacheKey, blob);
                return blob;
            })
            .catch((error) => {
                imageBlobCacheRef.current.delete(cacheKey);
                throw error;
            });
        imageBlobCacheRef.current.set(cacheKey, request);
        return request;
    }, [session?.access_token]);

    useEffect(() => {
        let active = true;
        let objectUrl = null;
        setOriginalImageUrl(null);
        setImageDimensions(null);

        if (!pageId || !session?.access_token) return undefined;

        getOriginalPageBlob(pageId)
            .then((blob) => {
                if (!active) return;
                objectUrl = URL.createObjectURL(blob);
                setOriginalImageUrl(objectUrl);
            })
            .catch((imageError) => {
                if (active) setError(imageError.message || "Impossible de charger l'image originale.");
            });

        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [getOriginalPageBlob, pageId, session?.access_token]);

    const prefetchAnnotatePage = useCallback((targetPage) => {
        const targetPageId = normalizePageId(targetPage?.id);
        if (!targetPageId || !session?.access_token) return;

        if (mangaSlug) {
            router.prefetch(`/${mangaSlug}/annotate/${targetPageId}`);
        }

        if (!pageCacheRef.current.has(targetPageId)) {
            const pagePromise = getPageById(targetPageId)
                .then(response => {
                    pageCacheRef.current.set(targetPageId, response.data);
                    return response.data;
                })
                .catch(error => {
                    pageCacheRef.current.delete(targetPageId);
                    throw error;
                });
            pageCacheRef.current.set(targetPageId, pagePromise);
            pagePromise.catch(() => {});
        }

        if (!bubbleCacheRef.current.has(targetPageId)) {
            const bubblesPromise = getBubblesForPage(targetPageId)
                .then(response => {
                    const sortedBubbles = sortBubblesForAnnotation(response.data);
                    bubbleCacheRef.current.set(targetPageId, sortedBubbles);
                    return sortedBubbles;
                })
                .catch(error => {
                    bubbleCacheRef.current.delete(targetPageId);
                    throw error;
                });
            bubbleCacheRef.current.set(targetPageId, bubblesPromise);
            bubblesPromise.catch(() => {});
        }

        getOriginalPageBlob(targetPageId).catch(() => {});
    }, [getOriginalPageBlob, mangaSlug, router, session?.access_token]);

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

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
        runBackgroundOcr, ocrResults, handleRetryWithCloud,
        selectedOcrModelKeys, toggleOcrModel
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
        runLocalOcr, runBackgroundOcr, setIsSubmitting, setLoadingText,
        detectionDebugEnabled, setDetectionDebugData
    });

    const runDebuggableDetection = useCallback(async (blob) => {
        const result = await detectBubbles(blob, {
            debug: detectionDebugEnabled,
            returnDebug: detectionDebugEnabled
        });
        if (!detectionDebugEnabled) return result;
        setDetectionDebugData(result?.debug || null);
        return result?.boxes || [];
    }, [detectBubbles, detectionDebugEnabled]);

    const setExistingBubblesAndCache = useCallback((updater) => {
        setExistingBubbles(prev => {
            const nextBubbles = typeof updater === 'function' ? updater(prev) : updater;
            if (Array.isArray(nextBubbles)) {
                cacheBubblesForPage(pageIdRef.current, nextBubbles);
            }
            return nextBubbles;
        });
    }, [cacheBubblesForPage]);

    const {
        isDrawing, startPoint, endPoint, mousePos, isShiftPressed,
        hoveredBubble, setHoveredBubble, handleMouseDown, handleMouseMove,
        handleMouseUp, handleInteractionStart
    } = useAnnotationInteractions({
        containerRef, imageRef, imageDimensions, existingBubbles, setExistingBubbles: setExistingBubblesAndCache,
        pendingAnnotation, setPendingAnnotation, setRectangle, canEdit, canEditBubble: canEditExistingBubble, isMobile,
        pageStatus: page?.statut, isSubmitting, showApiKeyModal, showDescModal
    });

    const fetchBubbles = useCallback(() => {
        if (pageId && (session?.access_token || isGuest)) {
            const gen = navGenerationRef.current;
            const cacheKey = normalizePageId(pageId);
            const cachedBubbles = cacheKey ? bubbleCacheRef.current.get(cacheKey) : null;
            const bubblesRequest = cachedBubbles
                ? Promise.resolve(cachedBubbles).catch(() => {
                    bubbleCacheRef.current.delete(cacheKey);
                    return getBubblesForPage(pageId).then(response => response.data);
                })
                : getBubblesForPage(pageId).then(response => response.data);

            bubblesRequest
                .then(response => {
                    if (gen !== navGenerationRef.current) return;
                    const sortedBubbles = sortBubblesForAnnotation(unwrapApiData(response));
                    cacheBubblesForPage(pageId, sortedBubbles);
                    setExistingBubbles(sortedBubbles);
                })
                .catch(error => console.error(error));
        }
    }, [cacheBubblesForPage, pageId, session?.access_token, isGuest]);

    useEffect(() => {
        if (pageId && (session?.access_token || isGuest)) {
            const gen = navGenerationRef.current;
            const cacheKey = normalizePageId(pageId);
            const cachedPage = cacheKey ? pageCacheRef.current.get(cacheKey) : null;
            const pageRequest = cachedPage
                ? Promise.resolve(cachedPage).catch(() => {
                    pageCacheRef.current.delete(cacheKey);
                    return getPageById(pageId).then(response => response.data);
                })
                : getPageById(pageId).then(response => response.data);

            pageRequest
                .then(response => {
                    if (gen !== navGenerationRef.current) return;
                    const pageData = unwrapApiData(response);
                    if (!pageData) throw new Error("Page non trouvée");
                    pageCacheRef.current.set(cacheKey, pageData);
                    setPage(pageData);
                    if (pageData.id_chapitre) {
                        getPages(pageData.id_chapitre)
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
        if (!pageId || chapterPages.length === 0 || !session?.access_token) return;
        getNearbyChapterPages(chapterPages, pageId).forEach(prefetchAnnotatePage);
    }, [chapterPages, pageId, prefetchAnnotatePage, session?.access_token]);

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
        if (!canEdit || !canEditExistingBubble(bubble) || isMobile) return;
        setPendingAnnotation(bubble);
        setIsModalOpen(true);
    };

    const handleDeleteBubble = async (bubbleId) => {
        if (isGuest || (isMobile && role !== 'Admin')) return;
        if (window.confirm("Supprimer cette annotation ?")) {
            const previousBubbles = [...existingBubbles];
            setExistingBubblesAndCache(prev => prev.filter(b => b.id !== bubbleId));
            try {
                await deleteBubble(bubbleId);
                toast.success("Annotation supprimée.");
            } catch (error) {
                setExistingBubblesAndCache(previousBubbles);
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
            setExistingBubblesAndCache(prev => {
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
                pageCacheRef.current.set(normalizePageId(pageId), response.data);
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
            pageCacheRef.current.set(normalizePageId(pageId), response.data);
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
        if (!canReorder || !pageId) return;
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubblesAndCache((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);
                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(pageId, orderedBubblesForApi).catch(() => fetchBubbles());
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
                    .then(b => runDebuggableDetection(b))
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
                setExistingBubblesAndCache(prev => {
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

    const handleOneShotPoneglyph = async ({ preferLocal = false, localEngine = 'lighton' } = {}) => {
        if (!imageRef.current) return;

        const isSuryaBBoxLocal = preferLocal && localEngine === 'surya_bbox';
        const runMode = preferLocal ? (isSuryaBBoxLocal ? 'surya-bbox-local' : 'local') : 'modal';
        const modelLabel = isSuryaBBoxLocal ? 'Surya-BBox' : 'Poneglyph-BBox';
        const inferenceModeLabel = preferLocal ? 'Local' : 'Modal';
        const serviceLabel = `${modelLabel} - ${inferenceModeLabel}`;
        setIsPoneglyphLoading(true);
        setPoneglyphRunMode(runMode);
        try {
            if (preferLocal && isSuryaBBoxLocal && !tauriLocalOcr.canRunLocalSuryaBBoxOcr) {
                throw new Error("Le modele Surya-BBox doit etre charge avant de lancer l'inference locale.");
            }
            if (preferLocal && !isSuryaBBoxLocal && !tauriLocalOcr.canRunLocalOcr) {
                throw new Error("Le modele Poneglyph-BBox doit etre charge avant de lancer l'inference locale.");
            }

            let yoloPromise = Promise.resolve(null);
            if (detectionStatus === 'ready') {
                yoloPromise = fetch(imageRef.current.src)
                    .then(r => r.blob())
                    .then(b => runDebuggableDetection(b))
                    .catch(e => {
                        console.error('YOLO Failed', e);
                        return null;
                    });
            }

            const imageBlob = await imageElementToJpegBlob(imageRef.current);
            if (!imageBlob) throw new Error("Impossible de convertir l'image.");

            const extractionPromise = (async () => {
                if (preferLocal) {
                    const localResult = isSuryaBBoxLocal
                        ? await tauriLocalOcr.runLocalSuryaBBoxOcrBlob(imageBlob)
                        : await tauriLocalOcr.runLocalOcrBlob(imageBlob);
                    if (localResult?.elapsed_ms) {
                        toast.success(`${modelLabel} - Local termine en ${localResult.elapsed_ms} ms.`);
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
                    texte_propose: capitalizeOcrSentenceStarts(bubble.content)
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

            toast.info(`Creation de ${newBubblesConfig.length} bulles ${modelLabel}...`);

            const createdBubbles = [];
            const { createBubble } = await import('@/lib/api');
            for (const bubbleConfig of newBubblesConfig) {
                try {
                    const res = await createBubble(bubbleConfig);
                    createdBubbles.push(res.data);
                } catch (e) {
                    console.error(`Erreur creation bulle ${modelLabel}`, e);
                }
            }

            if (createdBubbles.length > 0) {
                setExistingBubblesAndCache(prev => {
                    const combined = [...prev, ...createdBubbles];
                    return combined.sort((a, b) => a.order - b.order);
                });
                toast.success(`${createdBubbles.length} bulles ${modelLabel} creees !`);
            } else {
                toast.error("Échec de la création des bulles.");
            }
        } catch (error) {
            console.error(error);
            toast.error(`${serviceLabel} indisponible : ${error.message}`);
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
                        ? "Telechargement du modele Poneglyph-BBox en cours."
                        : !tauriLocalOcr.localModelStatus?.installed
                            ? "Telechargez le modele Poneglyph-BBox d'abord."
                            : !tauriLocalOcr.localModelStatus?.ready
                                ? "Chargez le modele Poneglyph-BBox en VRAM d'abord."
                            : "Poneglyph-BBox indisponible.";
            toast.error(reason);
            return;
        }
        return handleOneShotPoneglyph({ preferLocal: true });
    };

    const handleOneShotLocalSuryaBbox = () => {
        if (!tauriLocalOcr.canRunLocalSuryaBBoxOcr) {
            const connectionState = tauriLocalOcr.localConnectionState?.status;
            const reason = !tauriLocalOcr.isTauri
                ? "App desktop non detectee."
                : connectionState === 'reconnecting'
                    ? "Serveur OCR local en reconnexion."
                    : ['offline', 'unavailable'].includes(connectionState)
                        ? "Serveur OCR local hors ligne."
                        : tauriLocalOcr.isDownloadingLocalSuryaBBoxModel
                            ? "Telechargement du modele Surya-BBox en cours."
                            : !tauriLocalOcr.localSuryaBBoxModelStatus?.installed
                                ? "Telechargez le modele Surya-BBox d'abord."
                                : tauriLocalOcr.localSuryaBBoxModelStatus?.error
                                    ? tauriLocalOcr.localSuryaBBoxModelStatus.error
                                    : !tauriLocalOcr.localSuryaBBoxModelStatus?.ready
                                        ? "Chargez le modele Surya-BBox en VRAM d'abord."
                                        : "Surya-BBox indisponible.";
            toast.error(reason);
            return;
        }
        return handleOneShotPoneglyph({ preferLocal: true, localEngine: 'surya_bbox' });
    };

    if (error) return <div className="p-8 text-red-500">{error}</div>;
    if (!page) return null;
    if (session?.access_token && !originalImageUrl) {
        return (
            <div className="flex min-h-[60vh] items-center justify-center gap-3 text-slate-300">
                <Loader2 className="h-5 w-5 animate-spin" />
                Chargement sécurisé de la page...
            </div>
        );
    }

    return (
        <div className="relative -mx-4 -my-7 flex h-[calc(100%+3.5rem)] flex-col overflow-hidden bg-[#030a13] sm:-mx-8 lg:-mx-10 lg:flex-row">
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
                selectedOcrModelKeys={selectedOcrModelKeys}
                toggleOcrModel={toggleOcrModel}
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
                handleOneShotPoneglyph={handleOneShotPoneglyph}
                isPoneglyphLoading={isPoneglyphLoading}
                poneglyphRunMode={poneglyphRunMode}
                handleOneShotLocalPoneglyph={handleOneShotLocalPoneglyph}
                handleOneShotLocalSuryaBbox={handleOneShotLocalSuryaBbox}
                isTauri={tauriLocalOcr.isTauri}
                isCheckingLocalConnection={tauriLocalOcr.isCheckingLocalConnection}
                localModelStatus={tauriLocalOcr.localModelStatus}
                localTextModelStatus={tauriLocalOcr.localTextModelStatus}
                localSuryaModelStatus={tauriLocalOcr.localSuryaModelStatus}
                localSuryaBBoxModelStatus={tauriLocalOcr.localSuryaBBoxModelStatus}
                localHealth={tauriLocalOcr.localHealth}
                localConnectionState={tauriLocalOcr.localConnectionState}
                isDownloadingLocalModel={tauriLocalOcr.isDownloadingLocalModel}
                isDownloadingLocalTextModel={tauriLocalOcr.isDownloadingLocalTextModel}
                isDownloadingLocalSuryaModel={tauriLocalOcr.isDownloadingLocalSuryaModel}
                isDownloadingLocalSuryaBBoxModel={tauriLocalOcr.isDownloadingLocalSuryaBBoxModel}
                localDownloadState={tauriLocalOcr.localDownloadState}
                localTextDownloadState={tauriLocalOcr.localTextDownloadState}
                localSuryaDownloadState={tauriLocalOcr.localSuryaDownloadState}
                localSuryaBBoxDownloadState={tauriLocalOcr.localSuryaBBoxDownloadState}
                localDownloadProgress={tauriLocalOcr.localDownloadProgress}
                localTextDownloadProgress={tauriLocalOcr.localTextDownloadProgress}
                localSuryaDownloadProgress={tauriLocalOcr.localSuryaDownloadProgress}
                localSuryaBBoxDownloadProgress={tauriLocalOcr.localSuryaBBoxDownloadProgress}
                isLoadingLocalModel={tauriLocalOcr.isLoadingLocalModel}
                isLoadingLocalTextModel={tauriLocalOcr.isLoadingLocalTextModel}
                isLoadingLocalSuryaModel={tauriLocalOcr.isLoadingLocalSuryaModel}
                isLoadingLocalSuryaBBoxModel={tauriLocalOcr.isLoadingLocalSuryaBBoxModel}
                isLocalInferencing={tauriLocalOcr.isLocalInferencing}
                isLocalSuryaBBoxInferencing={tauriLocalOcr.isLocalSuryaBBoxInferencing}
                localError={tauriLocalOcr.localError}
                canRunLocalOcr={tauriLocalOcr.canRunLocalOcr}
                canRunLocalTextOcr={tauriLocalOcr.canRunLocalTextOcr}
                canRunLocalSuryaOcr={tauriLocalOcr.canRunLocalSuryaOcr}
                canRunLocalSuryaBBoxOcr={tauriLocalOcr.canRunLocalSuryaBBoxOcr}
                downloadLocalModel={tauriLocalOcr.downloadLocalModel}
                downloadLocalTextModel={tauriLocalOcr.downloadLocalTextModel}
                downloadLocalSuryaModel={tauriLocalOcr.downloadLocalSuryaModel}
                downloadLocalSuryaBBoxModel={tauriLocalOcr.downloadLocalSuryaBBoxModel}
                loadLocalModel={tauriLocalOcr.loadLocalModel}
                loadLocalTextModel={tauriLocalOcr.loadLocalTextModel}
                loadLocalSuryaModel={tauriLocalOcr.loadLocalSuryaModel}
                loadLocalSuryaBBoxModel={tauriLocalOcr.loadLocalSuryaBBoxModel}
                refreshLocalDiagnostics={tauriLocalOcr.refreshLocalDiagnostics}
            />

            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#030a13]">

                <header className="z-20 flex h-auto min-h-16 flex-none items-center justify-between border-b border-white/10 bg-[#06111e] px-4 py-3 shadow-sm lg:hidden">
                    <div className="flex items-center gap-3 shrink-0">
                        <Link href={`/${mangaSlug}/dashboard`}>
                            <Button variant="ghost" size="icon" className="h-9 w-9">
                                <ArrowLeft className="h-5 w-5" />
                            </Button>
                        </Link>
                        <div className="flex flex-col">
                            <h2 className="max-w-[120px] truncate text-sm font-bold text-white">
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
                        canEditBubble={canEditExistingBubble}
                        imageDimensions={imageDimensions}
                        setImageDimensions={setImageDimensions}
                        containerRef={containerRef}
                        imageRef={imageRef}
                        handleMouseDown={handleMouseDown}
                        handleMouseMove={handleMouseMove}
                        handleMouseUp={handleMouseUp}
                        imageUrl={session?.access_token
                            ? originalImageUrl
                            : getProxiedImageUrl(page.url_image, pageId)}
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
                        detectionDebugEnabled={detectionDebugEnabled}
                        detectionDebugData={detectionDebugData}
                    />

                    <AnnotateAnnotationSidebar
                        existingBubbles={existingBubbles}
                        handleDragEnd={handleDragEnd}
                        user={user}
                        handleEditBubble={handleEditBubble}
                        handleDeleteBubble={handleDeleteBubble}
                        canEdit={canEdit}
                        canEditBubble={canEditExistingBubble}
                        canReorder={canReorder}
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
                selectedOcrModelKeys={selectedOcrModelKeys}
            />

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API</DialogTitle>
                        <DialogDescription>Gérez votre clé API.</DialogDescription>
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
