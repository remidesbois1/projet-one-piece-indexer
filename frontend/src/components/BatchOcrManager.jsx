"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useDetection } from '@/context/DetectionContext';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
import { getAdminHierarchy, getBubblesForPage, createBubble, validateBubble } from '@/lib/api';
import { getProxiedImageUrl, cropImage } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
    ArrowLeft, Play, Loader2, CheckCircle2, AlertTriangle,
    SkipForward, Zap, X, Wand2, Cpu, CloudLightning
} from "lucide-react";

function performRaliement(poneglyphBubbles, yoloBoxes, imgW, imgH) {
    const candidates = [];

    for (let pi = 0; pi < poneglyphBubbles.length; pi++) {
        const raw = poneglyphBubbles[pi];
        const [x1, y1, x2, y2] = raw.bbox;
        const pBox = {
            x: Math.round((x1 / 1000) * imgW),
            y: Math.round((y1 / 1000) * imgH),
            w: Math.round(((x2 - x1) / 1000) * imgW),
            h: Math.round(((y2 - y1) / 1000) * imgH),
            texte_propose: raw.content
        };

        for (let yi = 0; yi < yoloBoxes.length; yi++) {
            const yBox = yoloBoxes[yi];

            const ix1 = Math.max(pBox.x, yBox.x);
            const iy1 = Math.max(pBox.y, yBox.y);
            const ix2 = Math.min(pBox.x + pBox.w, yBox.x + yBox.w);
            const iy2 = Math.min(pBox.y + pBox.h, yBox.y + yBox.h);

            if (ix2 < ix1 || iy2 < iy1) continue;

            const intersection = (ix2 - ix1) * (iy2 - iy1);
            const areaP = pBox.w * pBox.h;
            const areaY = yBox.w * yBox.h;
            const iou = intersection / (areaP + areaY - intersection);

            if (iou > 0.05) {
                candidates.push({ pi, yi, iou, yoloBox: yBox, poneglyphText: pBox.texte_propose || '' });
            }
        }
    }

    candidates.sort((a, b) => b.iou - a.iou);

    const matches = [];
    const usedPoneglyph = new Set();
    const usedYolo = new Set();

    for (const c of candidates) {
        if (usedPoneglyph.has(c.pi) || usedYolo.has(c.yi)) continue;
        usedPoneglyph.add(c.pi);
        usedYolo.add(c.yi);
        matches.push({
            yoloBoxIndex: c.yi,
            yoloBox: c.yoloBox,
            poneglyphText: c.poneglyphText,
            iou: c.iou,
            poneglyphIndex: c.pi
        });
    }

    matches.sort((a, b) => a.poneglyphIndex - b.poneglyphIndex);

    const unmatchedYoloIndices = yoloBoxes
        .map((_, i) => i)
        .filter(i => !usedYolo.has(i));

    return { matches, unmatchedYoloIndices };
}

function boxArea(box) {
    return Math.max(0, box.w) * Math.max(0, box.h);
}

function boxIou(a, b) {
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(a.x + a.w, b.x + b.w);
    const iy2 = Math.min(a.y + a.h, b.y + b.h);
    const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const union = boxArea(a) + boxArea(b) - intersection;
    return union > 0 ? intersection / union : 0;
}

function toGeometry(item) {
    return {
        x: Number(item.x),
        y: Number(item.y),
        w: Number(item.w),
        h: Number(item.h)
    };
}

function imageToJpegBlob(img) {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
}

async function runLightOnClassic(img, rect, provider, tauriLocalOcr) {
    const blob = await cropImage(img, rect);
    if (provider === 'local') {
        const data = await tauriLocalOcr.runLocalTextOcrBlob(blob);
        return data?.text || '';
    }

    const response = await fetch('/api/local_lighton', {
        method: 'POST',
        body: blob
    });
    if (!response.ok) throw new Error("Erreur LightOn classique");
    const data = await response.json();
    return data.text || '';
}

async function runPoneglyphBBox(jpegBlob, provider, tauriLocalOcr) {
    if (provider === 'local') {
        return tauriLocalOcr.runLocalOcrBlob(jpegBlob);
    }

    return fetch('/api/poneglyph_one_shot', {
        method: 'POST',
        body: jpegBlob
    }).then(r => {
        if (!r.ok) throw new Error("Erreur API Poneglyph");
        return r.json();
    }).then(data => {
        if (data.error) throw new Error(data.error);
        return data;
    });
}

function loadImageLocal(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        img.src = src;
    });
}

function getReviewItemKey(item) {
    return `${item.pageId}-${item.order}-${item.yoloBox.x}-${item.yoloBox.y}-${item.yoloBox.w}-${item.yoloBox.h}`;
}

function getSuggestedReviewText(item) {
    return item.poneglyphText || item.lightonText || '';
}

export default function BatchOcrManager() {
    const { detectionStatus, loadDetectionModel, downloadProgress, detectBubblesPositionsOnly } = useDetection();
    const tauriLocalOcr = useTauriLocalOcrContext();
    const params = useParams();

    const [hierarchy, setHierarchy] = useState([]);
    const [selectedChapterId, setSelectedChapterId] = useState('');
    const [phase, setPhase] = useState('idle');
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    const [pageStatuses, setPageStatuses] = useState([]);
    const [reviewQueue, setReviewQueue] = useState([]);
    const [customReviewTexts, setCustomReviewTexts] = useState({});
    const [stats, setStats] = useState({ autoValidated: 0, totalReview: 0, errors: 0 });
    const [processingReview, setProcessingReview] = useState(false);
    const [ocrProvider, setOcrProvider] = useState('modal');

    const startRequestedRef = useRef(false);
    const abortRef = useRef(false);
    const processingBatchRef = useRef(false);
    const processingReviewRef = useRef(false);
    const knownPageBoxesRef = useRef(new Map());

    useEffect(() => {
        getAdminHierarchy().then(({ data }) => setHierarchy(data || [])).catch(console.error);
    }, []);

    useEffect(() => {
        if (detectionStatus === 'ready' && startRequestedRef.current) {
            startRequestedRef.current = false;
            startProcessing();
        }
    }, [detectionStatus]);

    useEffect(() => {
        if (phase === 'review' && reviewQueue.length === 0) {
            setPhase('done');
        }
    }, [reviewQueue.length, phase]);

    const getAllChapters = useCallback(() => {
        const chapters = [];
        for (const tome of hierarchy) {
            for (const chap of (tome.chapitres || [])) {
                chapters.push({ ...chap, tomeNumero: tome.numero, tomeTitre: tome.titre });
            }
        }
        return chapters.sort((a, b) => {
            if (a.tomeNumero !== b.tomeNumero) return a.tomeNumero - b.tomeNumero;
            return a.numero - b.numero;
        });
    }, [hierarchy]);

    const getSelectedChapterPages = useCallback(() => {
        for (const tome of hierarchy) {
            for (const chap of (tome.chapitres || [])) {
                if (String(chap.id) === String(selectedChapterId)) {
                    return (chap.pages || []).sort((a, b) => a.numero_page - b.numero_page);
                }
            }
        }
        return [];
    }, [hierarchy, selectedChapterId]);

    const rememberPageBox = (pageId, box) => {
        const key = String(pageId);
        const boxes = knownPageBoxesRef.current.get(key) || [];
        boxes.push(toGeometry(box));
        knownPageBoxesRef.current.set(key, boxes);
    };

    const hasKnownPageBox = (pageId, box) => {
        const boxes = knownPageBoxesRef.current.get(String(pageId)) || [];
        return boxes.some(existingBox => boxIou(existingBox, box) >= 0.9);
    };

    const canUseLocalBatch = Boolean(tauriLocalOcr.canRunLocalOcr && tauriLocalOcr.canRunLocalTextOcr);

    const getLocalBatchDisabledReason = () => {
        if (!tauriLocalOcr.isTauri) return "App desktop non detectee.";
        if (!tauriLocalOcr.localModelStatus?.ready) return "Chargez le modele BBox local.";
        if (!tauriLocalOcr.localTextModelStatus?.ready) return "Chargez le modele Poneglyph local.";
        return "OCR local indisponible.";
    };

    const handleProviderChange = (value) => {
        if (value === 'local' && !canUseLocalBatch) {
            toast.error(getLocalBatchDisabledReason());
            return;
        }
        setOcrProvider(value);
    };

    const handleStart = () => {
        if (!selectedChapterId) {
            toast.error("Veuillez sélectionner un chapitre.");
            return;
        }
        if (ocrProvider === 'local' && !canUseLocalBatch) {
            toast.error(getLocalBatchDisabledReason());
            return;
        }
        if (detectionStatus === 'ready') {
            startProcessing();
        } else {
            startRequestedRef.current = true;
            setPhase('loading-model');
            loadDetectionModel();
        }
    };

    const startProcessing = async () => {
        if (processingBatchRef.current) return;
        processingBatchRef.current = true;
        const pages = getSelectedChapterPages();
        if (pages.length === 0) {
            toast.error("Aucune page dans ce chapitre.");
            setPhase('idle');
            processingBatchRef.current = false;
            return;
        }

        abortRef.current = false;
        processingReviewRef.current = false;
        knownPageBoxesRef.current = new Map();
        setPhase('processing');
        setProgress({ current: 0, total: pages.length });
        setPageStatuses(pages.map(p => ({ id: p.id, numero: p.numero_page, status: 'pending' })));

        const allReviewItems = [];
        let autoValidated = 0;
        let errors = 0;

        try {
            for (let i = 0; i < pages.length; i++) {
                if (abortRef.current) break;

                const page = pages[i];
                setProgress(prev => ({ ...prev, current: i + 1 }));
                setPageStatuses(prev => prev.map((ps, idx) => idx === i ? { ...ps, status: 'processing' } : ps));

                try {
                    const result = await processPage(page);
                    allReviewItems.push(...result.reviewItems);
                    autoValidated += result.autoValidatedCount;
                    setPageStatuses(prev => prev.map((ps, idx) =>
                        idx === i ? { ...ps, status: 'done', bubbleCount: result.autoValidatedCount + result.reviewItems.length } : ps
                    ));
                } catch (e) {
                    console.error(`Page ${page.numero_page} error:`, e);
                    errors++;
                    setPageStatuses(prev => prev.map((ps, idx) =>
                        idx === i ? { ...ps, status: 'error', error: e.message } : ps
                    ));
                }
            }

            setReviewQueue(allReviewItems);
            setStats({ autoValidated, totalReview: allReviewItems.length, errors });
            setPhase(allReviewItems.length > 0 ? 'review' : 'done');
        } finally {
            processingBatchRef.current = false;
        }
    };

    const processPage = async (page) => {
        const imageUrl = getProxiedImageUrl(page.url_image);
        const img = await loadImageLocal(imageUrl);

        try {
            const { data } = await getBubblesForPage(page.id);
            knownPageBoxesRef.current.set(String(page.id), (data || []).map(toGeometry));
        } catch (e) {
            console.warn(`[Batch] Page ${page.numero_page}: existing bubbles unavailable`, e);
            knownPageBoxesRef.current.set(String(page.id), []);
        }

        const jpegBlob = await imageToJpegBlob(img);
        if (!jpegBlob) {
            console.error(`[Batch] Page ${page.numero_page}: jpegBlob is null (canvas tainted?)`);
            throw new Error("Impossible de convertir l'image");
        }

        const imgBlob = await fetch(imageUrl).then(r => r.blob());

        const [yoloBoxes, poneglyphResponse] = await Promise.all([
            detectBubblesPositionsOnly(imgBlob).catch(e => {
                console.error('YOLO failed:', e);
                return [];
            }),
            runPoneglyphBBox(jpegBlob, ocrProvider, tauriLocalOcr).catch(e => {
                console.error('Poneglyph failed:', e);
                return { bubbles: [] };
            })
        ]);

        const poneglyphBubbles = poneglyphResponse.bubbles || [];

        console.log(`[Batch] Page ${page.numero_page}: YOLO=${yoloBoxes.length} bubbles, Poneglyph=${poneglyphBubbles.length} bubbles`);
        console.log(`[Batch] Page ${page.numero_page}: img=${img.naturalWidth}x${img.naturalHeight}`);
        if (yoloBoxes.length > 0) console.log(`[Batch] Page ${page.numero_page}: YOLO sample:`, JSON.stringify(yoloBoxes[0]));
        if (poneglyphBubbles.length > 0) console.log(`[Batch] Page ${page.numero_page}: Poneglyph raw bbox:`, JSON.stringify(poneglyphBubbles[0].bbox));

        const { matches, unmatchedYoloIndices } = performRaliement(
            poneglyphBubbles, yoloBoxes, img.naturalWidth, img.naturalHeight
        );

        if (poneglyphBubbles.length > 0 && yoloBoxes.length > 0) {
            const pRaw = poneglyphBubbles[0].bbox;
            const [px1, py1, px2, py2] = pRaw;
            console.log(`[Batch] Page ${page.numero_page}: Poneglyph[0] converted:`, JSON.stringify({
                x: Math.round((px1 / 1000) * img.naturalWidth),
                y: Math.round((py1 / 1000) * img.naturalHeight),
                w: Math.round(((px2 - px1) / 1000) * img.naturalWidth),
                h: Math.round(((py2 - py1) / 1000) * img.naturalHeight)
            }));
        }

        console.log(`[Batch] Page ${page.numero_page}: rallied=${matches.length}, unmatched_yolo=${unmatchedYoloIndices.length}`);

        let lightonTexts = [];
        if (ocrProvider === 'local') {
            for (const box of yoloBoxes) {
                if (box.w <= 0 || box.h <= 0) {
                    lightonTexts.push('');
                    continue;
                }
                try {
                    lightonTexts.push(await runLightOnClassic(img, box, ocrProvider, tauriLocalOcr));
                } catch (e) {
                    console.error('LightOn failed:', e);
                    lightonTexts.push('');
                }
            }
        } else {
            const lightonPromises = yoloBoxes.map((box) => {
                if (box.w <= 0 || box.h <= 0) return Promise.resolve('');
                return runLightOnClassic(img, box, ocrProvider, tauriLocalOcr).catch(e => {
                    console.error('LightOn failed:', e);
                    return '';
                });
            });
            lightonTexts = await Promise.all(lightonPromises);
        }

        const reviewItems = [];
        let autoValidatedCount = 0;
        const pendingReviewBoxes = [];
        const claimReviewBox = (box) => {
            if (hasKnownPageBox(page.id, box)) return false;
            if (pendingReviewBoxes.some(existingBox => boxIou(existingBox, box) >= 0.9)) return false;
            pendingReviewBoxes.push(toGeometry(box));
            return true;
        };

        for (const match of matches) {
            const lightonText = lightonTexts[match.yoloBoxIndex] || '';
            const poneglyphText = match.poneglyphText || '';
            const bubbleOrder = match.poneglyphIndex + 1;

            if (poneglyphText && poneglyphText === lightonText) {
                if (hasKnownPageBox(page.id, match.yoloBox)) continue;
                try {
                    const { data: bubble } = await createBubble({
                        id_page: page.id,
                        x: match.yoloBox.x,
                        y: match.yoloBox.y,
                        w: match.yoloBox.w,
                        h: match.yoloBox.h,
                        texte_propose: poneglyphText,
                        order: bubbleOrder
                    });
                    rememberPageBox(page.id, match.yoloBox);
                    try {
                        await validateBubble(bubble.id);
                        autoValidatedCount++;
                    } catch (e) {
                        console.error('Auto-validation failed after creation:', e);
                    }
                } catch (e) {
                    console.error('Auto-validate failed:', e);
                    if (!claimReviewBox(match.yoloBox)) continue;
                    const cropBlob = await cropImage(img, match.yoloBox);
                    reviewItems.push({
                        pageId: page.id,
                        pageNumber: page.numero_page,
                        yoloBox: match.yoloBox,
                        poneglyphText,
                        lightonText,
                        rallied: true,
                        cropUrl: URL.createObjectURL(cropBlob),
                        order: bubbleOrder,
                    });
                }
            } else {
                if (!claimReviewBox(match.yoloBox)) continue;
                const cropBlob = await cropImage(img, match.yoloBox);
                reviewItems.push({
                    pageId: page.id,
                    pageNumber: page.numero_page,
                    yoloBox: match.yoloBox,
                    poneglyphText,
                    lightonText,
                    rallied: true,
                    cropUrl: URL.createObjectURL(cropBlob),
                    order: bubbleOrder,
                });
            }
        }

        for (let ui = 0; ui < unmatchedYoloIndices.length; ui++) {
            const yoloIdx = unmatchedYoloIndices[ui];
            const yoloBox = yoloBoxes[yoloIdx];
            if (!claimReviewBox(yoloBox)) continue;
            const lightonText = lightonTexts[yoloIdx] || '';
            if (!lightonText) continue;

            const cropBlob = await cropImage(img, yoloBox);
            reviewItems.push({
                pageId: page.id,
                pageNumber: page.numero_page,
                yoloBox,
                poneglyphText: null,
                lightonText,
                rallied: false,
                cropUrl: URL.createObjectURL(cropBlob),
                order: poneglyphBubbles.length + ui + 1,
            });
        }

        return { reviewItems, autoValidatedCount };
    };

    const handleChoose = async (item, chosenText) => {
        if (!chosenText || processingReviewRef.current) return;
        processingReviewRef.current = true;
        setProcessingReview(true);
        try {
            if (hasKnownPageBox(item.pageId, item.yoloBox)) {
                toast.info("Bulle déjà présente, ignorée.");
                return;
            }

            const { data: bubble } = await createBubble({
                id_page: item.pageId,
                x: item.yoloBox.x,
                y: item.yoloBox.y,
                w: item.yoloBox.w,
                h: item.yoloBox.h,
                texte_propose: chosenText,
                order: item.order
            });
            rememberPageBox(item.pageId, item.yoloBox);
            await validateBubble(bubble.id);
            toast.success("Bulle créée et validée !");
        } catch (e) {
            toast.error("Erreur: " + e.message);
        } finally {
            URL.revokeObjectURL(item.cropUrl);
            setCustomReviewTexts(prev => {
                const next = { ...prev };
                delete next[getReviewItemKey(item)];
                return next;
            });
            setReviewQueue(prev => prev.filter(r => r !== item));
            processingReviewRef.current = false;
            setProcessingReview(false);
        }
    };

    const handleCustomTextChange = (item, text) => {
        const key = getReviewItemKey(item);
        setCustomReviewTexts(prev => ({ ...prev, [key]: text }));
    };

    const handleChooseCustom = (item) => {
        const key = getReviewItemKey(item);
        const text = (customReviewTexts[key] ?? getSuggestedReviewText(item)).trim();
        if (!text) {
            toast.error("Le texte personnalisé est vide.");
            return;
        }
        handleChoose(item, text);
    };

    const handleSkip = (item) => {
        URL.revokeObjectURL(item.cropUrl);
        setCustomReviewTexts(prev => {
            const next = { ...prev };
            delete next[getReviewItemKey(item)];
            return next;
        });
        setReviewQueue(prev => prev.filter(r => r !== item));
    };

    const handleAcceptAll = async (source) => {
        if (processingReviewRef.current) return;
        processingReviewRef.current = true;
        setProcessingReview(true);
        try {
            const items = [...reviewQueue].sort((a, b) => a.order - b.order);
            let count = 0;
            for (const item of items) {
                const text = source === 'poneglyph' ? item.poneglyphText : item.lightonText;
                if (!text) continue;
                if (hasKnownPageBox(item.pageId, item.yoloBox)) {
                    URL.revokeObjectURL(item.cropUrl);
                    continue;
                }
                try {
                    const { data: bubble } = await createBubble({
                        id_page: item.pageId,
                        x: item.yoloBox.x,
                        y: item.yoloBox.y,
                        w: item.yoloBox.w,
                        h: item.yoloBox.h,
                        texte_propose: text,
                        order: item.order
                    });
                    rememberPageBox(item.pageId, item.yoloBox);
                    await validateBubble(bubble.id);
                    count++;
                } catch (e) {
                    console.error('Batch accept error:', e);
                }
                URL.revokeObjectURL(item.cropUrl);
            }
            setReviewQueue([]);
            setCustomReviewTexts({});
            toast.success(`${count} bulles créées et validées !`);
        } finally {
            processingReviewRef.current = false;
            setProcessingReview(false);
        }
    };

    const handleSkipAll = () => {
        reviewQueue.forEach(item => URL.revokeObjectURL(item.cropUrl));
        setReviewQueue([]);
        setCustomReviewTexts({});
    };

    const handleCancel = () => {
        abortRef.current = true;
        setPhase('idle');
    };

    const handleReset = () => {
        setPhase('idle');
        setReviewQueue([]);
        setCustomReviewTexts({});
        setPageStatuses([]);
        setStats({ autoValidated: 0, totalReview: 0, errors: 0 });
    };

    const chapters = getAllChapters();
    const providerLabel = ocrProvider === 'local' ? 'Local Tauri' : 'Modal GPU';

    return (
        <div className="container max-w-6xl mx-auto py-10 px-4 space-y-6">
            <div className="relative overflow-hidden rounded-3xl border border-indigo-100 bg-gradient-to-br from-white via-indigo-50/70 to-sky-50 p-6 shadow-sm">
                <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-indigo-200/40 blur-3xl" />
                <div className="relative flex items-center gap-3">
                <Link href={`/${params.mangaSlug}/admin?tab=batch`}>
                    <Button variant="outline" size="sm" className="bg-white/80">
                        <ArrowLeft className="h-4 w-4 mr-1" />
                        Admin
                    </Button>
                </Link>
                <div>
                    <div className="flex items-center gap-2">
                        <Wand2 className="h-6 w-6 text-indigo-600" />
                        <h1 className="text-3xl font-extrabold tracking-tight text-slate-950">Batch OCR</h1>
                    </div>
                    <p className="text-sm text-slate-600">Détection, double OCR, puis validation rapide des bulles ambiguës.</p>
                </div>
                </div>
            </div>

            {phase === 'idle' && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Zap className="h-5 w-5 text-indigo-600" />
                            Configuration
                        </CardTitle>
                        <CardDescription>
                            Sélectionnez un chapitre. YOLO détecte les bulles, Poneglyph BBox + LightOn Classique font l&apos;OCR. Les résultats concordants sont auto-validés.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-[1fr_240px_auto] md:items-end">
                            <div className="flex-1">
                                <label className="text-sm font-medium text-slate-700 mb-1.5 block">Chapitre</label>
                                <Select value={selectedChapterId} onValueChange={setSelectedChapterId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Sélectionner un chapitre..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {chapters.map(ch => (
                                            <SelectItem key={ch.id} value={String(ch.id)}>
                                                T.{ch.tomeNumero} - Ch.{ch.numero}{ch.titre ? ` : ${ch.titre}` : ''} ({(ch.pages || []).length}p)
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div>
                                <label className="text-sm font-medium text-slate-700 mb-1.5 block">OCR</label>
                                <Select value={ocrProvider} onValueChange={handleProviderChange}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Source OCR" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="modal">
                                            <span className="inline-flex items-center gap-2"><CloudLightning className="h-3.5 w-3.5" /> Modal GPU</span>
                                        </SelectItem>
                                        <SelectItem value="local" disabled={!canUseLocalBatch}>
                                            <span className="inline-flex items-center gap-2"><Cpu className="h-3.5 w-3.5" /> Local Tauri</span>
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button onClick={handleStart} disabled={!selectedChapterId || (ocrProvider === 'local' && !canUseLocalBatch)} className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg">
                                <Play className="h-4 w-4 mr-2" />
                                Lancer le batch
                            </Button>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs font-semibold text-slate-600">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline" className="bg-white">Provider: {providerLabel}</Badge>
                                {tauriLocalOcr.isTauri && <Badge variant="outline" className={tauriLocalOcr.localModelStatus?.ready ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-white"}>BBox {tauriLocalOcr.localModelStatus?.ready ? "chargé" : "non chargé"}</Badge>}
                                {tauriLocalOcr.isTauri && <Badge variant="outline" className={tauriLocalOcr.localTextModelStatus?.ready ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-white"}>Poneglyph {tauriLocalOcr.localTextModelStatus?.ready ? "chargé" : "non chargé"}</Badge>}
                            </div>
                            {tauriLocalOcr.isTauri && !canUseLocalBatch && (
                                <p className="mt-2 text-[11px] text-slate-500">Local batch disponible quand les modèles BBox et Poneglyph sont tous les deux chargés.</p>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {phase === 'loading-model' && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
                            Chargement du modèle YOLO...
                        </CardTitle>
                        <CardDescription>Téléchargement des modèles de détection de bulles</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Progress value={downloadProgress} />
                        <p className="text-sm text-slate-500">{downloadProgress}%</p>
                        <Button variant="ghost" onClick={handleCancel}>Annuler</Button>
                    </CardContent>
                </Card>
            )}

            {phase === 'processing' && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
                            Traitement en cours...
                        </CardTitle>
                        <CardDescription>Page {progress.current} / {progress.total} - {providerLabel}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <Progress value={(progress.current / progress.total) * 100} />
                        <div className="flex flex-wrap gap-2">
                            {pageStatuses.map(ps => (
                                <div key={ps.id} className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium ${
                                    ps.status === 'done' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                                    ps.status === 'processing' ? 'bg-indigo-50 border-indigo-200 text-indigo-700 animate-pulse' :
                                    ps.status === 'error' ? 'bg-red-50 border-red-200 text-red-700' :
                                    'bg-slate-50 border-slate-200 text-slate-400'
                                }`}>
                                    P.{ps.numero}
                                    {ps.status === 'done' && ` ✅${ps.bubbleCount || ''}`}
                                    {ps.status === 'processing' && ' ⏳'}
                                    {ps.status === 'error' && ' ❌'}
                                </div>
                            ))}
                        </div>
                        <Button variant="ghost" onClick={handleCancel} className="text-red-600 hover:text-red-700">
                            Annuler le traitement
                        </Button>
                    </CardContent>
                </Card>
            )}

            {phase === 'review' && (
                <>
                    <Card className="border-indigo-100 shadow-sm">
                        <CardContent className="py-4">
                            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                                <div className="flex flex-wrap gap-4">
                                    <div className="flex items-center gap-1.5">
                                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                        <span className="text-sm font-medium">{stats.autoValidated} auto-validées</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                                        <span className="text-sm font-medium">{reviewQueue.length} à vérifier</span>
                                    </div>
                                    {stats.errors > 0 && (
                                        <div className="flex items-center gap-1.5">
                                            <X className="h-4 w-4 text-red-600" />
                                            <span className="text-sm font-medium">{stats.errors} erreurs</span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button size="sm" variant="outline" onClick={() => handleAcceptAll('lighton')} disabled={processingReview}>
                                        Tout LightOn
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => handleAcceptAll('poneglyph')} disabled={processingReview}>
                                        Tout Poneglyph
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={handleSkipAll} className="text-red-600">
                                        Tout ignorer
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <div className="grid gap-3">
                        {reviewQueue.map((item, idx) => {
                            const itemKey = getReviewItemKey(item);
                            const customText = customReviewTexts[itemKey] ?? getSuggestedReviewText(item);

                            return (
                            <Card key={itemKey} className="overflow-hidden border-slate-200 shadow-sm">
                                <div className="grid gap-0 md:grid-cols-[160px_1fr_52px]">
                                    <div className="min-h-40 bg-white flex items-center justify-center p-3 md:border-r border-slate-200">
                                        <img
                                            src={item.cropUrl}
                                            alt={`Bulle page ${item.pageNumber}`}
                                            className="max-w-full max-h-full object-contain"
                                        />
                                    </div>

                                    <div className="p-4 space-y-3 bg-white">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="outline">Page {item.pageNumber}</Badge>
                                            <Badge variant="outline">Ordre {item.order}</Badge>
                                            {item.rallied ? (
                                                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">Rallié</Badge>
                                            ) : (
                                                <Badge className="bg-amber-50 text-amber-700 border-amber-200">YOLO seul</Badge>
                                            )}
                                            <span className="text-xs text-slate-400">#{idx + 1} / {reviewQueue.length}</span>
                                        </div>

                                        <div className={`grid gap-2 ${item.rallied ? 'lg:grid-cols-2' : 'grid-cols-1'}`}>
                                            {item.rallied && (
                                                <div className="p-3 rounded-lg border border-slate-200 bg-white">
                                                    <p className="text-xs font-semibold text-slate-500 mb-1">Poneglyph BBox ({providerLabel})</p>
                                                    <p className="min-h-10 text-sm text-slate-900 whitespace-pre-wrap">{item.poneglyphText || <em className="text-slate-400">vide</em>}</p>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className="mt-2 w-full"
                                                        onClick={() => handleChoose(item, item.poneglyphText)}
                                                        disabled={!item.poneglyphText || processingReview}
                                                    >
                                                        Utiliser
                                                    </Button>
                                                </div>
                                            )}

                                            <div className="p-3 rounded-lg border border-slate-200 bg-white">
                                                <p className="text-xs font-semibold text-slate-500 mb-1">LightOn Classique ({providerLabel})</p>
                                                <p className="min-h-10 text-sm text-slate-900 whitespace-pre-wrap">{item.lightonText || <em className="text-slate-400">vide</em>}</p>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="mt-2 w-full"
                                                    onClick={() => handleChoose(item, item.lightonText)}
                                                    disabled={!item.lightonText || processingReview}
                                                >
                                                    Utiliser
                                                </Button>
                                            </div>
                                        </div>

                                        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                                            <p className="mb-2 text-xs font-semibold text-slate-500">Texte à enregistrer</p>
                                            <Textarea
                                                value={customText}
                                                onChange={(event) => handleCustomTextChange(item, event.target.value)}
                                                className="min-h-16 resize-y bg-white"
                                                placeholder="Modifier ou saisir le texte..."
                                            />
                                            <Button
                                                size="sm"
                                                className="mt-2 bg-indigo-600 text-white hover:bg-indigo-700"
                                                onClick={() => handleChooseCustom(item)}
                                                disabled={!customText.trim() || processingReview}
                                            >
                                                Valider
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-center border-t border-slate-200 bg-white md:border-l md:border-t-0">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => handleSkip(item)}
                                            className="text-red-400 hover:text-red-600"
                                        >
                                            <SkipForward className="h-5 w-5" />
                                        </Button>
                                    </div>
                                </div>
                            </Card>
                            );
                        })}
                    </div>
                </>
            )}

            {phase === 'done' && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-emerald-700">
                            <CheckCircle2 className="h-6 w-6" />
                            Batch terminé !
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid grid-cols-3 gap-4">
                            <div className="text-center p-4 bg-emerald-50 rounded-xl border border-emerald-100">
                                <p className="text-2xl font-bold text-emerald-700">{stats.autoValidated}</p>
                                <p className="text-xs text-emerald-600">Auto-validées</p>
                            </div>
                            <div className="text-center p-4 bg-blue-50 rounded-xl border border-blue-100">
                                <p className="text-2xl font-bold text-blue-700">{stats.totalReview - reviewQueue.length}</p>
                                <p className="text-xs text-blue-600">Manuellement validées</p>
                            </div>
                            <div className="text-center p-4 bg-slate-50 rounded-xl border border-slate-200">
                                <p className="text-2xl font-bold text-slate-500">{reviewQueue.length}</p>
                                <p className="text-xs text-slate-500">Ignorées</p>
                            </div>
                        </div>
                        {stats.errors > 0 && (
                            <p className="text-sm text-red-600 flex items-center gap-1">
                                <X className="h-3.5 w-3.5" />
                                {stats.errors} page(s) en erreur
                            </p>
                        )}
                        <Button onClick={handleReset} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                            Nouveau batch
                        </Button>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
