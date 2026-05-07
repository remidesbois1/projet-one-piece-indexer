"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useDetection } from '@/context/DetectionContext';
import { getAdminHierarchy, createBubble, validateBubble } from '@/lib/api';
import { getProxiedImageUrl, cropImage } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
    ArrowLeft, Play, Loader2, CheckCircle2, AlertTriangle,
    SkipForward, Zap, X
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

async function runLightOnClassic(img, rect) {
    const blob = await cropImage(img, rect);
    const response = await fetch('/api/local_lighton', {
        method: 'POST',
        body: blob
    });
    if (!response.ok) throw new Error("Erreur LightOn classique");
    const data = await response.json();
    return data.text || '';
}

function loadImageLocal(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        img.src = src;
    });
}

export default function BatchOcrManager() {
    const { detectionStatus, loadDetectionModel, downloadProgress, detectBubblesPositionsOnly } = useDetection();
    const params = useParams();

    const [hierarchy, setHierarchy] = useState([]);
    const [selectedChapterId, setSelectedChapterId] = useState('');
    const [phase, setPhase] = useState('idle');
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    const [pageStatuses, setPageStatuses] = useState([]);
    const [reviewQueue, setReviewQueue] = useState([]);
    const [stats, setStats] = useState({ autoValidated: 0, totalReview: 0, errors: 0 });
    const [processingReview, setProcessingReview] = useState(false);

    const startRequestedRef = useRef(false);
    const abortRef = useRef(false);

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

    const handleStart = () => {
        if (!selectedChapterId) {
            toast.error("Veuillez sélectionner un chapitre.");
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
        const pages = getSelectedChapterPages();
        if (pages.length === 0) {
            toast.error("Aucune page dans ce chapitre.");
            setPhase('idle');
            return;
        }

        abortRef.current = false;
        setPhase('processing');
        setProgress({ current: 0, total: pages.length });
        setPageStatuses(pages.map(p => ({ id: p.id, numero: p.numero_page, status: 'pending' })));

        const allReviewItems = [];
        let autoValidated = 0;
        let errors = 0;

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
    };

    const processPage = async (page) => {
        const imageUrl = getProxiedImageUrl(page.url_image);
        const img = await loadImageLocal(imageUrl);

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
            fetch('/api/poneglyph_one_shot', {
                method: 'POST',
                body: jpegBlob
            }).then(r => {
                if (!r.ok) throw new Error("Erreur API Poneglyph");
                return r.json();
            }).then(data => {
                if (data.error) throw new Error(data.error);
                return data;
            }).catch(e => {
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

        const lightonPromises = yoloBoxes.map((box) => {
            if (box.w <= 0 || box.h <= 0) return Promise.resolve('');
            return runLightOnClassic(img, box).catch(e => {
                console.error('LightOn failed:', e);
                return '';
            });
        });
        const lightonTexts = await Promise.all(lightonPromises);

        const reviewItems = [];
        let autoValidatedCount = 0;

        for (const match of matches) {
            const lightonText = lightonTexts[match.yoloBoxIndex] || '';
            const poneglyphText = match.poneglyphText || '';
            const bubbleOrder = match.poneglyphIndex + 1;

            if (poneglyphText && poneglyphText === lightonText) {
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
                    await validateBubble(bubble.id);
                    autoValidatedCount++;
                } catch (e) {
                    console.error('Auto-validate failed:', e);
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
        if (!chosenText) return;
        setProcessingReview(true);
        try {
            const { data: bubble } = await createBubble({
                id_page: item.pageId,
                x: item.yoloBox.x,
                y: item.yoloBox.y,
                w: item.yoloBox.w,
                h: item.yoloBox.h,
                texte_propose: chosenText,
                order: item.order
            });
            await validateBubble(bubble.id);
            toast.success("Bulle créée et validée !");
        } catch (e) {
            toast.error("Erreur: " + e.message);
        }
        URL.revokeObjectURL(item.cropUrl);
        setReviewQueue(prev => prev.filter(r => r !== item));
        setProcessingReview(false);
    };

    const handleSkip = (item) => {
        URL.revokeObjectURL(item.cropUrl);
        setReviewQueue(prev => prev.filter(r => r !== item));
    };

    const handleAcceptAll = async (source) => {
        setProcessingReview(true);
        const items = [...reviewQueue].sort((a, b) => a.order - b.order);
        let count = 0;
        for (const item of items) {
            const text = source === 'poneglyph' ? item.poneglyphText : item.lightonText;
            if (!text) continue;
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
                await validateBubble(bubble.id);
                count++;
            } catch (e) {
                console.error('Batch accept error:', e);
            }
            URL.revokeObjectURL(item.cropUrl);
        }
        setReviewQueue([]);
        toast.success(`${count} bulles créées et validées !`);
        setProcessingReview(false);
    };

    const handleSkipAll = () => {
        reviewQueue.forEach(item => URL.revokeObjectURL(item.cropUrl));
        setReviewQueue([]);
    };

    const handleCancel = () => {
        abortRef.current = true;
        setPhase('idle');
    };

    const handleReset = () => {
        setPhase('idle');
        setReviewQueue([]);
        setPageStatuses([]);
        setStats({ autoValidated: 0, totalReview: 0, errors: 0 });
    };

    const chapters = getAllChapters();

    return (
        <div className="container max-w-5xl mx-auto py-10 px-4 space-y-6">
            <div className="flex items-center gap-3 pb-6 border-b border-slate-200">
                <Link href={`/${params.mangaSlug}/admin?tab=batch`}>
                    <Button variant="ghost" size="sm">
                        <ArrowLeft className="h-4 w-4 mr-1" />
                        Admin
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">Batch OCR</h1>
                    <p className="text-sm text-slate-500">Traitement automatique d&apos;un chapitre complet</p>
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
                        <div className="flex gap-3 items-end">
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
                            <Button onClick={handleStart} disabled={!selectedChapterId} className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg">
                                <Play className="h-4 w-4 mr-2" />
                                Lancer le batch
                            </Button>
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
                        <CardDescription>Page {progress.current} / {progress.total}</CardDescription>
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
                    <Card>
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
                                <div className="flex gap-2">
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

                    <div className="space-y-3">
                        {reviewQueue.map((item, idx) => (
                            <Card key={idx} className="overflow-hidden">
                                <div className="flex">
                                    <div className="w-36 h-36 bg-slate-100 flex-shrink-0 flex items-center justify-center p-2 border-r border-slate-200">
                                        <img
                                            src={item.cropUrl}
                                            alt={`Bulle page ${item.pageNumber}`}
                                            className="max-w-full max-h-full object-contain"
                                        />
                                    </div>

                                    <div className="flex-1 p-4 space-y-3">
                                        <div className="flex items-center gap-2">
                                            <Badge variant="outline">Page {item.pageNumber}</Badge>
                                            {item.rallied ? (
                                                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">Rallié</Badge>
                                            ) : (
                                                <Badge className="bg-amber-50 text-amber-700 border-amber-200">YOLO seul</Badge>
                                            )}
                                        </div>

                                        <div className={`grid gap-3 ${item.rallied ? 'grid-cols-2' : 'grid-cols-1'}`}>
                                            {item.rallied && (
                                                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
                                                    <p className="text-xs font-semibold text-indigo-600 mb-1">Poneglyph BBox</p>
                                                    <p className="text-sm text-slate-800">{item.poneglyphText || <em className="text-slate-400">vide</em>}</p>
                                                    <Button
                                                        size="sm"
                                                        className="mt-2 w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                                                        onClick={() => handleChoose(item, item.poneglyphText)}
                                                        disabled={!item.poneglyphText || processingReview}
                                                    >
                                                        Choisir
                                                    </Button>
                                                </div>
                                            )}

                                            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
                                                <p className="text-xs font-semibold text-emerald-600 mb-1">LightOn Classique</p>
                                                <p className="text-sm text-slate-800">{item.lightonText || <em className="text-slate-400">vide</em>}</p>
                                                <Button
                                                    size="sm"
                                                    className="mt-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                                                    onClick={() => handleChoose(item, item.lightonText)}
                                                    disabled={!item.lightonText || processingReview}
                                                >
                                                    Choisir
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center pr-3">
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
                        ))}
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
