"use client";

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { OCR_MODELS } from '@/context/WorkerContext';
import { arrayMove } from '@dnd-kit/sortable';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import { useAnnotationOCR } from '@/hooks/useAnnotationOCR';
import { useAnnotationDetection } from '@/hooks/useAnnotationDetection';
import { useAnnotationMetadata } from '@/hooks/useAnnotationMetadata';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
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
    const response = await fetch('/api/poneglyph_one_shot', {
        method: 'POST',
        body: imageBlob
    });

    if (!response.ok) throw new Error("Erreur API Poneglyph");
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
    const [poneglyphRunMode, setPoneglyphRunMode] = useState(null);

    const containerRef = useRef(null);
    const imageRef = useRef(null);
    const fileInputRef = useRef(null);
    const tauriLocalOcr = useTauriLocalOcrContext();

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
    }, [imageUrl]);

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
        runBackgroundOcr, handleRetryWithCloud
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

    const handleOneShotPoneglyph = async ({ preferLocal = false } = {}) => {
        if (!imageRef.current) return;

        const runMode = preferLocal ? 'local' : 'modal';
        setIsPoneglyphLoading(true);
        setPoneglyphRunMode(runMode);

        try {
            if (preferLocal && !tauriLocalOcr.canRunLocalOcr) {
                throw new Error("Le modele local doit etre charge avant de lancer le one-shot local.");
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
                ? tauriLocalOcr.runLocalOcrBlob(imageBlob)
                : runModalPoneglyph(imageBlob);

            const [apiResponse, yoloBoxes] = await Promise.all([
                extractionPromise,
                yoloPromise
            ]);

            if (preferLocal && apiResponse?.elapsed_ms) {
                toast.success(`OCR local termine en ${apiResponse.elapsed_ms} ms.`);
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
                    texte_propose: bubble.content || '',
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
            toast.success(`${newBubbles.length} bulles Poneglyph creees dans la sandbox.`);
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
                    ? "Telechargement du modele local en cours."
                    : !tauriLocalOcr.localModelStatus?.installed
                        ? "Telechargez le modele local d'abord."
                        : !tauriLocalOcr.localModelStatus?.ready
                            ? "Chargez le modele local en VRAM d'abord."
                            : "OCR local indisponible.";
            toast.error(reason);
            return;
        }

        return handleOneShotPoneglyph({ preferLocal: true });
    };

    if (!page) {
        return (
            <div className="relative flex flex-col items-center justify-center min-h-screen bg-white overflow-hidden p-6"
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}>
                <div className="absolute left-4 top-4 z-20">
                    <LocalOcrStatusIndicator />
                </div>

                <div className="absolute inset-0 -z-10">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] bg-[#2F7AAF]/5 rounded-full blur-3xl" />
                    <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-[#2F7AAF]/5 rounded-full blur-3xl" />
                </div>
                <PoneglyphBackground count={32} seed={123} />

                <div className="max-w-md w-full space-y-12 relative z-10">
                    <div className="text-center space-y-4">
                        <h1 className="text-4xl font-extrabold tracking-tight leading-none text-balance" style={{ color: '#2F7AAF' }}>
                            Sandbox annotation
                        </h1>
                        <p className="text-slate-500 text-sm leading-relaxed max-w-[380px] mx-auto text-balance">
                            Expérimentez l&apos;annotation du projet directement dans votre navigateur.
                            Cette interface utilise une version fine-tuné de <a href="https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector_Nano" target="_blank" rel="noopener noreferrer" className="font-bold text-slate-700 hover:text-[#2F7AAF] underline decoration-slate-200">YOLO26</a> pour la détection,
                            <a href="https://huggingface.co/Remidesbois/ReaderNet-V5" target="_blank" rel="noopener noreferrer" className="font-bold text-slate-700 hover:text-[#2F7AAF] underline decoration-slate-200"> ReaderNet</a> pour l&apos;ordre des cases, et
                            <a href="https://huggingface.co/Remidesbois/trocr-onepiece-fr-large" target="_blank" rel="noopener noreferrer" className="font-bold text-slate-700 hover:text-[#2F7AAF] underline decoration-slate-200"> TrOCR</a> pour la reconnaissance.
                            Dans l&apos;app desktop, elle peut aussi lancer LightOnOCR en local via Tauri.
                        </p>
                    </div>

                    <div
                        className="group relative border-2 border-dashed border-slate-200 hover:border-[#2F7AAF]/50 bg-white/80 backdrop-blur-sm rounded-3xl p-14 transition-all-300 cursor-pointer text-center shadow-xl shadow-slate-200/50 hover:shadow-[#2F7AAF]/10"
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
                            <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center group-hover:bg-[#2F7AAF]/10 group-hover:text-[#2F7AAF] transition-colors shadow-sm border border-slate-100">
                                <Upload size={24} />
                            </div>
                            <div className="space-y-1">
                                <p className="text-slate-900 font-bold group-hover:text-[#2F7AAF] transition-colors">
                                    Charger une planche
                                </p>
                                <p className="text-[11px] text-slate-400 font-medium">Glissez-déposez ou cliquez ici</p>
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-center pt-4">
                        <Link href="/" className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-all uppercase tracking-widest bg-slate-50 hover:bg-slate-100 px-4 py-2 rounded-full border border-slate-200/50">
                            <ArrowLeft size={12} />
                            Retour Accueil
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col lg:flex-row h-screen bg-slate-50 overflow-hidden relative">
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
                detectionStatus={detectionStatus}
                loadDetectionModel={loadDetectionModel}
                detectionProgress={detectionProgress}
                downloadStats={downloadStats}
                handleExecuteDetection={handleExecuteDetection}
                isSubmitting={isSubmitting}
                isAutoDetecting={isAutoDetecting}
                queueLength={queueLength}
                setShowDescModal={() => { }}
                setShowApiKeyModal={() => { }}
                handleSubmitPage={() => { }}
                handleOneShotPoneglyph={handleOneShotPoneglyph}
                isPoneglyphLoading={isPoneglyphLoading}
                poneglyphRunMode={poneglyphRunMode}
                handleOneShotLocalPoneglyph={handleOneShotLocalPoneglyph}
                isTauri={tauriLocalOcr.isTauri}
                localModelStatus={tauriLocalOcr.localModelStatus}
                isDownloadingLocalModel={tauriLocalOcr.isDownloadingLocalModel}
                localDownloadState={tauriLocalOcr.localDownloadState}
                localConnectionState={tauriLocalOcr.localConnectionState}
                isLocalInferencing={tauriLocalOcr.isLocalInferencing}
                canRunLocalOcr={tauriLocalOcr.canRunLocalOcr}
            />

            <div className="flex flex-col flex-1 overflow-hidden min-w-0 bg-slate-50 relative">
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
                activeModelKey={activeModelKey}
                OCR_MODELS={OCR_MODELS}
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
