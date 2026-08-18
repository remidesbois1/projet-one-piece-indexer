"use client";

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { arrayMove } from '@dnd-kit/sortable';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import { useAnnotationOCR } from '@/hooks/useAnnotationOCR';
import { useAnnotationDetection } from '@/hooks/useAnnotationDetection';
import { useAnnotationMetadata } from '@/hooks/useAnnotationMetadata';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
import { capitalizeOcrSentenceStarts } from '@/lib/ocr-utils';
import { postOcrImage } from '@/lib/ocrProxyClient';
import { getChatGptStatus, runChatGptPageOcr } from '@/lib/chatGptDesktop';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowLeft, Upload } from "lucide-react";
import { toast } from "sonner";
import AnnotateLeftSidebar from '@/components/AnnotateLeftSidebar';
import AnnotateCanvas from '@/components/AnnotateCanvas';
import AnnotateAnnotationSidebar from '@/components/AnnotateAnnotationSidebar';
import AnnotateEditorDialog from '@/components/AnnotateEditorDialog';
import AnnotateMetadataModal from '@/components/AnnotateMetadataModal';
import LocalOcrStatusIndicator from '@/components/LocalOcrStatusIndicator';
import ApiKeyForm from '@/components/ApiKeyForm';

const PONEGLYPH_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateSlots(count, seed = 12345) {
    const slots = [];
    let state = seed;
    const nextRand = () => {
        let t = state += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < count; i++) {
        slots.push({
            x: 2 + nextRand() * 92,
            y: 2 + nextRand() * 92,
            size: 20 + Math.floor(nextRand() * 32),
            rotate: Math.floor(nextRand() * 80) - 40,
            char: PONEGLYPH_LETTERS[Math.floor(nextRand() * 26)],
            opacity: 0,
        });
    }
    return slots;
}

function PoneglyphBackground({ count = 20, seed = 0 }) {
    const [glyphs, setGlyphs] = React.useState(() => generateSlots(count, seed));

    React.useEffect(() => {
        const timers = [];
        glyphs.forEach((_, i) => {
            const cycle = () => {
                const delay = 500 + Math.random() * 3500;
                const fadeIn = setTimeout(() => {
                    setGlyphs(prev => prev.map((g, idx) =>
                        idx === i ? { ...g, opacity: 1, char: PONEGLYPH_LETTERS[Math.floor(Math.random() * 26)] } : g
                    ));
                    const stayDuration = 2500 + Math.random() * 4500;
                    const fadeOut = setTimeout(() => {
                        setGlyphs(prev => prev.map((g, idx) =>
                            idx === i ? { ...g, opacity: 0 } : g
                        ));
                        const nextTimer = setTimeout(cycle, 1000 + Math.random() * 2000);
                        timers.push(nextTimer);
                    }, stayDuration);
                    timers.push(fadeOut);
                }, delay);
                timers.push(fadeIn);
            };
            cycle();
        });
        return () => timers.forEach(t => clearTimeout(t));
    }, []);

    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
            {glyphs.map((g, i) => (
                <span
                    key={i}
                    className="absolute"
                    style={{
                        fontFamily: "'Poneglyph', serif",
                        fontSize: `${g.size}px`,
                        left: `${g.x}%`,
                        top: `${g.y}%`,
                        transform: `rotate(${g.rotate}deg)`,
                        opacity: g.opacity * 0.18,
                        transition: 'opacity 2.5s ease-in-out',
                        color: '#2F7AAF',
                        lineHeight: 1,
                    }}
                >
                    {g.char}
                </span>
            ))}
        </div>
    );
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
    const response = await postOcrImage('/api/poneglyph_one_shot', imageBlob, {
        allowAnonymous: true,
    });

    if (!response.ok) throw new Error("Erreur API Poneglyph-BBox");
    return response.json();
}

export default function SandboxClient() {
    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
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
    const [imageUrl, setImageUrl] = useState(null);
    const [isPoneglyphLoading, setIsPoneglyphLoading] = useState(false);
    const [isChatGptLoading, setIsChatGptLoading] = useState(false);
    const [chatGptDesktopAvailable, setChatGptDesktopAvailable] = useState(false);
    const [poneglyphRunMode, setPoneglyphRunMode] = useState(null);

    const containerRef = useRef(null);
    const imageRef = useRef(null);
    const fileInputRef = useRef(null);
    const tauriLocalOcr = useTauriLocalOcrContext();

    useEffect(() => {
        let cancelled = false;
        getChatGptStatus().then(status => {
            if (!cancelled) setChatGptDesktopAvailable(status.available);
        });
        return () => { cancelled = true; };
    }, []);

    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const handleImageUpload = (file) => {
        if (!file || !file.type.startsWith('image/')) {
            toast.error("Veuillez sélectionner une image valide.");
            return;
        }
        const url = URL.createObjectURL(file);
        setImageUrl(url);
        setPage({
            id: 'sandbox-page',
            url_image: url,
            statut: 'not_started',
            numero_page: 0,
            description: null
        });
        setExistingBubbles([]);
        toast.success("Image chargée ! Prêt pour l&apos;annotation.");
    };

    const onDrop = (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        handleImageUpload(file);
    };

    const {
        formData, setFormData, charInput, setCharInput,
        isSavingDesc, isGeneratingAI, tabMode, setTabMode, jsonInput,
        jsonError, handleJsonChange, handleSaveDescription, handleGenerateAI,
    } = useAnnotationMetadata({
        page, setPage, pageId: 'sandbox', imageRef, showDescModal, setShowDescModal, setShowApiKeyModal,
        onSaveDescription: async (payload) => {
            setPage(prev => ({ ...prev, description: JSON.stringify(payload) }));
            return { data: { success: true } };
        },
        onFetchSuggestions: async () => ({ data: { arcs: [], characters: [] } })
    });

    const {
        preferLocalOCR, toggleOcrPreference, activeModelKey,
        modelStatus, loadModel, switchModel, downloadProgress, runLocalOcr,
        runBackgroundOcr, handleRetryWithCloud, selectedOcrModelKeys, toggleOcrModel
    } = useAnnotationOCR({
        imageRef, pageId: 'sandbox', rectangle, pendingAnnotation, setPendingAnnotation,
        setIsSubmitting, setLoadingText, setIsModalOpen, setOcrSource,
        setDebugImageUrl, setShowApiKeyModal, isSandbox: true
    });

    const {
        isAutoDetecting, setIsAutoDetecting, queueLength, detectionStatus,
        loadDetectionModel, detectionProgress, downloadStats, handleExecuteDetection,
        processNextBubble, detectBubbles
    } = useAnnotationDetection({
        imageRef, pageId: 'sandbox', setRectangle, setPendingAnnotation, setDebugImageUrl,
        runLocalOcr, runBackgroundOcr, setIsSubmitting, setLoadingText
    });

    const {
        isDrawing, startPoint, endPoint, mousePos, isShiftPressed,
        hoveredBubble, setHoveredBubble, handleMouseDown, handleMouseMove,
        handleMouseUp, handleInteractionStart
    } = useAnnotationInteractions({
        containerRef, imageRef, imageDimensions, existingBubbles, setExistingBubbles,
        pendingAnnotation, setPendingAnnotation, setRectangle, canEdit: true, isMobile,
        pageStatus: 'not_started', isSubmitting, showApiKeyModal, showDescModal,
        onUpdateGeometry: (targetId, geometry) => {
            setExistingBubbles(prev => prev.map(b => b.id === targetId ? { ...b, ...geometry } : b));
            toast.success("Position mise à jour");
        }
    });

    useEffect(() => {
        if (isAutoDetecting) return;
        if (rectangle && imageRef.current) {
            const analysisData = { id: Date.now(), id_page: 'sandbox', ...rectangle, texte_propose: '' };
            setPendingAnnotation(analysisData);
            setDebugImageUrl(null);
            runLocalOcr(analysisData);
        }
    }, [rectangle, isAutoDetecting, activeModelKey]);

    const handleSaveApiKey = (key) => {
        localStorage.setItem('google_api_key', key);
        setShowApiKeyModal(false);
        if (pendingAnnotation) handleRetryWithCloud();
        if (showDescModal) handleSaveDescription();
    };

    const handleEditBubble = (bubble) => {
        if (isMobile) return;
        setPendingAnnotation(bubble);
        setIsModalOpen(true);
    };

    const handleDeleteBubble = (bubbleId) => {
        if (window.confirm("Supprimer cette annotation locale ?")) {
            setExistingBubbles(prev => prev.filter(b => b.id !== bubbleId));
            toast.success("Annotation supprimée.");
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
                    results.push({ ...newData, id: newData.id || Date.now() });
                }

                return results.sort((a, b) => (a.order || 0) - (b.order || 0));
            });
        }
    };

    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);
                return newOrder.map((b, index) => ({ ...b, order: index + 1 }));
            });
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
                    .then(b => detectBubbles(b))
                    .catch(e => {
                        console.error('YOLO Failed', e);
                        return null;
                    });
            }

            const imageBlob = await imageElementToJpegBlob(imageRef.current);
            if (!imageBlob) throw new Error("Impossible de convertir l'image.");

            const extractionPromise = preferLocal
                ? (isSuryaBBoxLocal
                    ? tauriLocalOcr.runLocalSuryaBBoxOcrBlob(imageBlob)
                    : tauriLocalOcr.runLocalOcrBlob(imageBlob))
                : runModalPoneglyph(imageBlob);

            const [apiResponse, yoloBoxes] = await Promise.all([
                extractionPromise,
                yoloPromise
            ]);

            if (preferLocal && apiResponse?.elapsed_ms) {
                toast.success(`${modelLabel} - Local termine en ${apiResponse.elapsed_ms} ms.`);
            }

            if (apiResponse?.error) {
                throw new Error(apiResponse.error);
            }

            if (!apiResponse?.bubbles || !Array.isArray(apiResponse.bubbles)) {
                throw new Error("Format de reponse invalide.");
            }

            const h = imageRef.current.naturalHeight;
            const w = imageRef.current.naturalWidth;
            const baseId = Date.now();

            const newBubbles = apiResponse.bubbles.map((bubble, index) => {
                const [x1, y1, x2, y2] = bubble.bbox;
                let poneglyphBox = {
                    id: `sandbox-poneglyph-${runMode}-${baseId}-${index}`,
                    id_page: 'sandbox',
                    x: Math.round((x1 / 1000) * w),
                    y: Math.round((y1 / 1000) * h),
                    w: Math.round(((x2 - x1) / 1000) * w),
                    h: Math.round(((y2 - y1) / 1000) * h),
                    texte_propose: capitalizeOcrSentenceStarts(bubble.content),
                    statut: 'Proposé',
                    id_user_createur: 'sandbox-user',
                    order: existingBubbles.length + index + 1
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

            if (newBubbles.length === 0) {
                toast.error("Aucune bulle detectee.");
                return;
            }

            setExistingBubbles(prev => [...prev, ...newBubbles].sort((a, b) => (a.order || 0) - (b.order || 0)));
            toast.success(`${newBubbles.length} bulles ${modelLabel} creees dans la sandbox.`);
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

    const handleChatGptOneShot = async () => {
        if (!imageRef.current) return;
        setIsChatGptLoading(true);
        try {
            const auth = await getChatGptStatus();
            if (!auth.available) throw new Error("GPT-5.6 Luna est disponible uniquement dans l'application desktop.");
            if (!auth.connected) {
                setShowApiKeyModal(true);
                toast.info('Connectez votre compte ChatGPT pour utiliser GPT-5.6 Luna.');
                return;
            }
            const imageBlob = await imageElementToJpegBlob(imageRef.current);
            if (!imageBlob) throw new Error("Impossible de convertir l'image.");
            const result = await runChatGptPageOcr(imageBlob);
            if (!Array.isArray(result?.bubbles)) throw new Error('Format de réponse OCR invalide.');
            const imageWidth = imageRef.current.naturalWidth;
            const imageHeight = imageRef.current.naturalHeight;
            const baseId = Date.now();
            const newBubbles = result.bubbles.map((bubble, index) => {
                const [x1, y1, x2, y2] = bubble.bbox;
                return {
                    id: `sandbox-chatgpt-${baseId}-${index}`,
                    id_page: 'sandbox',
                    x: Math.round((x1 / 1000) * imageWidth),
                    y: Math.round((y1 / 1000) * imageHeight),
                    w: Math.round(((x2 - x1) / 1000) * imageWidth),
                    h: Math.round(((y2 - y1) / 1000) * imageHeight),
                    texte_propose: bubble.content,
                    statut: 'Proposé',
                    id_user_createur: 'sandbox-user',
                    order: existingBubbles.length + index + 1,
                };
            });
            if (!newBubbles.length) throw new Error('Aucune bulle exploitable détectée.');
            setExistingBubbles(previous => [...previous, ...newBubbles].sort((a, b) => (a.order || 0) - (b.order || 0)));
            toast.success(`${newBubbles.length} bulles créées avec GPT-5.6 Luna.`);
        } catch (error) {
            console.error(error);
            toast.error(error?.message || 'OCR GPT-5.6 Luna indisponible.');
        } finally {
            setIsChatGptLoading(false);
        }
    };

    if (!page) {
        return (
            <div className="poneglyph-app relative flex min-h-screen flex-col items-center justify-center overflow-hidden p-6"
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}>
                <div className="absolute left-4 top-4 z-20">
                    <LocalOcrStatusIndicator />
                </div>

                <PoneglyphBackground count={32} seed={123} />

                <div className="max-w-md w-full space-y-12 relative z-10">
                    <div className="text-center space-y-4">
                        <h1 className="poneglyph-title text-balance text-4xl font-extrabold leading-none">
                            Sandbox annotation
                        </h1>
                        <p className="poneglyph-muted text-balance mx-auto max-w-[380px] text-sm leading-relaxed">
                            Expérimentez l&apos;annotation du projet directement dans votre navigateur.
                            Cette interface utilise <a href="https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models" target="_blank" rel="noopener noreferrer" className="font-bold text-slate-700 hover:text-[#2F7AAF] underline decoration-slate-200">YoloPiece One-Shot</a> pour la détection et l&apos;ordre local,
                            <a href="https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec" target="_blank" rel="noopener noreferrer" className="font-bold text-slate-700 hover:text-[#2F7AAF] underline decoration-slate-200"> PP-OCRv6 Ligne</a> pour la reconnaissance.
                            Dans l&apos;app desktop, elle peut aussi lancer Poneglyph en mode local via Tauri.
                        </p>
                    </div>

                    <div
                        className="poneglyph-panel group relative cursor-pointer rounded-3xl border-2 border-dashed border-white/16 p-14 text-center transition hover:border-[#8dbbff]/55 hover:bg-[#0a1d30]/86"
                        onClick={() => fileInputRef.current.click()}
                    >
                        <input
                            type="file"
                            className="hidden"
                            ref={fileInputRef}
                            accept="image/*"
                            onChange={(e) => handleImageUpload(e.target.files[0])}
                        />
                        <div className="flex flex-col items-center gap-5">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/12 bg-white/8 text-[#8dbbff] shadow-sm transition-colors group-hover:bg-[#3d86ff]/18 group-hover:text-white">
                                <Upload size={24} />
                            </div>
                            <div className="space-y-1">
                                <p className="font-bold text-white transition-colors group-hover:text-[#8dbbff]">
                                    Charger une planche
                                </p>
                                <p className="text-[11px] text-slate-400 font-medium">Glissez-déposez ou cliquez ici</p>
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-center pt-4">
                        <Link href="/" className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-400 transition-all hover:bg-white/12 hover:text-white">
                            <ArrowLeft size={12} />
                            Retour Accueil
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="poneglyph-app relative flex h-screen flex-col overflow-hidden lg:flex-row">
            <AnnotateLeftSidebar
                fromSearch={false}
                mangaSlug=""
                page={page}
                chapterPages={[]}
                navContext={{ prev: null, next: null }}
                goToPrev={() => { }}
                goToNext={() => { }}
                isGuest={false}
                role="Admin"
                isSandbox={true}
                preferLocalOCR={preferLocalOCR}
                toggleOcrPreference={toggleOcrPreference}
                activeModelKey={activeModelKey}
                switchModel={switchModel}
                modelStatus={modelStatus}
                loadModel={loadModel}
                downloadProgress={downloadProgress}
                geminiKey={null}
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
                setShowDescModal={() => { }}
                setShowApiKeyModal={setShowApiKeyModal}
                handleSubmitPage={() => { }}
                handleOneShotPoneglyph={handleOneShotPoneglyph}
                handleChatGptOneShot={handleChatGptOneShot}
                isChatGptLoading={isChatGptLoading}
                chatGptDesktopAvailable={chatGptDesktopAvailable}
                isPoneglyphLoading={isPoneglyphLoading}
                poneglyphRunMode={poneglyphRunMode}
                handleOneShotLocalPoneglyph={handleOneShotLocalPoneglyph}
                handleOneShotLocalSuryaBbox={handleOneShotLocalSuryaBbox}
                isTauri={tauriLocalOcr.isTauri}
                localModelStatus={tauriLocalOcr.localModelStatus}
                localTextModelStatus={tauriLocalOcr.localTextModelStatus}
                localSuryaModelStatus={tauriLocalOcr.localSuryaModelStatus}
                localSuryaBBoxModelStatus={tauriLocalOcr.localSuryaBBoxModelStatus}
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
                localConnectionState={tauriLocalOcr.localConnectionState}
                isLoadingLocalModel={tauriLocalOcr.isLoadingLocalModel}
                isLoadingLocalTextModel={tauriLocalOcr.isLoadingLocalTextModel}
                isLoadingLocalSuryaModel={tauriLocalOcr.isLoadingLocalSuryaModel}
                isLoadingLocalSuryaBBoxModel={tauriLocalOcr.isLoadingLocalSuryaBBoxModel}
                isLocalInferencing={tauriLocalOcr.isLocalInferencing}
                isLocalSuryaBBoxInferencing={tauriLocalOcr.isLocalSuryaBBoxInferencing}
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
            />

            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#030a13]">
                <div className="absolute left-3 top-3 z-30">
                    <LocalOcrStatusIndicator />
                </div>


                <div className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-0">
                    <AnnotateCanvas
                        canEdit={true}
                        imageDimensions={imageDimensions}
                        setImageDimensions={setImageDimensions}
                        containerRef={containerRef}
                        imageRef={imageRef}
                        handleMouseDown={handleMouseDown}
                        handleMouseMove={handleMouseMove}
                        handleMouseUp={handleMouseUp}
                        imageUrl={imageUrl}
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
                        user={{ id: 'sandbox-user', role: 'Admin' }}
                        handleEditBubble={handleEditBubble}
                        handleDeleteBubble={handleDeleteBubble}
                        canEdit={true}
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
                isSandbox={true}
            />

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API Google Vision</DialogTitle>
                        <DialogDescription>Requis uniquement pour les modèles Cloud et l&apos;Embedding.</DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>

            <AnnotateMetadataModal
                isOpen={showDescModal}
                onOpenChange={setShowDescModal}
                tabMode={tabMode}
                setTabMode={setTabMode}
                formData={formData}
                setFormData={setFormData}
                charInput={charInput}
                setCharInput={setCharInput}
                suggestions={{ arcs: [], characters: [] }}
                isGeneratingAI={isGeneratingAI}
                handleGenerateAI={handleGenerateAI}
                handleSaveDescription={handleSaveDescription}
                isSavingDesc={isSavingDesc}
                jsonInput={jsonInput}
                handleJsonChange={handleJsonChange}
                jsonError={jsonError}
            />
        </div>
    );
}
