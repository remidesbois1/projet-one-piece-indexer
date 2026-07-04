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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
    ArrowLeft, Play, Loader2, CheckCircle2, AlertTriangle,
    SkipForward, Zap, X, Wand2, Cpu, CloudLightning,
    Search, ChevronRight, Check
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
    if (!response.ok) throw new Error("Erreur Poneglyph");
    const data = await response.json();
    return data.text || '';
}

async function runSuryaClassic(img, rect, tauriLocalOcr) {
    const blob = await cropImage(img, rect);
    const data = await tauriLocalOcr.runLocalSuryaOcrBlob(blob);
    return data?.text || '';
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
    return item.poneglyphText || item.lightonText || item.suryaText || '';
}

function normalizeOcrText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function getConsensusText(texts) {
    const normalized = texts.map(normalizeOcrText);
    if (normalized.some(text => !text)) return null;
    const first = normalized[0];
    return normalized.every(text => text === first) ? String(texts[0] || '').trim() : null;
}

function getReviewTextBySource(item, source) {
    if (source === 'poneglyph') return item.poneglyphText || '';
    if (source === 'lighton') return item.lightonText || '';
    if (source === 'surya') return item.suryaText || '';
    return '';
}

function getReviewSources(item, providerLabel) {
    const sources = [];

    if (item.rallied) {
        sources.push({
            key: 'poneglyph',
            label: `Poneglyph-BBox (${providerLabel})`,
            text: item.poneglyphText || '',
        });
    }

    sources.push({
        key: 'lighton',
        label: `Poneglyph (${providerLabel})`,
        text: item.lightonText || '',
    });

    if (item.suryaEnabled) {
        sources.push({
            key: 'surya',
            label: 'Surya Local',
            text: item.suryaText || '',
        });
    }

    return sources;
}

function normalizeDiffToken(value) {
    return String(value || '').trim();
}

function tokenizeDiffText(value) {
    const text = String(value || '');
    if (!text) return [];
    return text.split(/(\s+)/).filter(part => part.length > 0).map(part => ({
        text: part,
        isSpace: /^\s+$/.test(part),
        normalized: normalizeDiffToken(part),
    }));
}

function buildDiffModel(sources) {
    const wordRows = sources.map(source =>
        tokenizeDiffText(source.text)
            .filter(token => !token.isSpace)
            .map(token => token.normalized)
    );
    const maxWords = Math.max(0, ...wordRows.map(row => row.length));
    const flags = wordRows.map(row => row.map(() => false));

    for (let index = 0; index < maxWords; index++) {
        const values = wordRows.map(row => row[index] || '');
        const filledValues = values.filter(Boolean);
        const allFilled = filledValues.length === values.length;
        const allSame = allFilled && new Set(filledValues).size === 1;

        if (allSame) continue;

        values.forEach((value, rowIndex) => {
            if (value) flags[rowIndex][index] = true;
        });
    }

    const nonEmptyTexts = sources.map(source => normalizeOcrText(source.text)).filter(Boolean);
    const uniqueTextCount = new Set(nonEmptyTexts).size;
    const emptyCount = sources.length - nonEmptyTexts.length;
    const changedTokenCount = flags.flat().filter(Boolean).length;
    const allIdentical = emptyCount === 0 && uniqueTextCount === 1;

    return {
        flags,
        allIdentical,
        changedTokenCount,
        emptyCount,
        label: allIdentical
            ? 'Textes identiques'
            : emptyCount > 0
                ? `${emptyCount} sortie${emptyCount > 1 ? 's' : ''} vide${emptyCount > 1 ? 's' : ''}`
                : `${uniqueTextCount} variantes`,
    };
}

function getSourceGridClass(sourceCount) {
    if (sourceCount >= 3) return 'lg:grid-cols-3';
    if (sourceCount === 2) return 'lg:grid-cols-2';
    return 'grid-cols-1';
}

function DiffText({ text, flags }) {
    const tokens = tokenizeDiffText(text);

    if (!String(text || '').trim()) {
        return <em className="text-slate-400">vide</em>;
    }

    const indexedTokens = tokens.reduce(
        (acc, token) => {
            if (token.isSpace) {
                return {
                    ...acc,
                    items: [...acc.items, { ...token, wordIndex: null }],
                };
            }

            const nextWordIndex = acc.wordIndex + 1;
            return {
                wordIndex: nextWordIndex,
                items: [...acc.items, { ...token, wordIndex: nextWordIndex }],
            };
        },
        { items: [], wordIndex: -1 }
    ).items;

    return indexedTokens.map((token, index) => {
        if (token.isSpace) return token.text;

        const isDifferent = Boolean(flags?.[token.wordIndex]);

        return (
            <span
                key={`${token.text}-${index}`}
                className={isDifferent ? "rounded bg-amber-100 px-0.5 text-amber-950 ring-1 ring-amber-200" : undefined}
            >
                {token.text}
            </span>
        );
    });
}

function OcrSourceCard({ source, diffFlags, onChoose, processingReview }) {
    const hasText = Boolean(String(source.text || '').trim());
    const hasDiff = Boolean(diffFlags?.some(Boolean));

    return (
        <div className={`rounded-lg border bg-[#081827]/88 p-3 ${hasDiff ? 'border-amber-400/40 shadow-sm shadow-amber-950/30' : 'border-white/12'}`}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-300">{source.label}</p>
                {hasDiff && <Badge className="border-amber-400/35 bg-amber-500/14 text-amber-200">Diff</Badge>}
            </div>
            <p className="min-h-10 whitespace-pre-wrap text-sm leading-6 text-slate-100">
                <DiffText text={source.text} flags={diffFlags} />
            </p>
            <Button
                size="sm"
                variant="outline"
                className="mt-2 w-full"
                onClick={() => onChoose(source.text)}
                disabled={!hasText || processingReview}
            >
                Utiliser
            </Button>
        </div>
    );
}

function ChapterCombobox({ chapters, value, onChange }) {
    const [open, setOpen] = useState(false);
    const selected = chapters.find(c => String(c.id) === String(value)) || null;

    const groupedByTome = chapters.reduce((acc, ch) => {
        const key = `Tome ${ch.tomeNumero}`;
        if (!acc[key]) acc[key] = [];
        acc[key].push(ch);
        return acc;
    }, {});

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="poneglyph-input h-10 w-full justify-between border-white/14 bg-[#040d18]/70 px-3 font-normal text-slate-100 hover:bg-[#0c1d2e] hover:text-white"
                >
                    <span className="flex items-center gap-2 truncate">
                        {selected ? (
                            <>
                                <Badge variant="outline" className="border-white/15 bg-white/8 text-slate-300">T.{selected.tomeNumero}</Badge>
                                <span className="truncate">Ch.{selected.numero}{selected.titre ? ` — ${selected.titre}` : ''}</span>
                                <span className="text-xs text-slate-500">({(selected.pages || []).length}p)</span>
                            </>
                        ) : (
                            <span className="flex items-center gap-2 text-slate-400">
                                <Search className="h-4 w-4" />
                                Rechercher un chapitre...
                            </span>
                        )}
                    </span>
                    <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[440px] max-w-[calc(100vw-2rem)] border-white/14 bg-[#071625]/96 p-0 backdrop-blur-xl" align="start">
                <Command className="bg-transparent">
                    <CommandInput placeholder="Tome, numéro ou titre..." className="text-slate-100" />
                    <CommandList className="max-h-[340px]">
                        <CommandEmpty className="py-6 text-center text-sm text-slate-400">Aucun chapitre</CommandEmpty>
                        {Object.entries(groupedByTome).map(([tomeLabel, tomeChapters]) => (
                            <CommandGroup key={tomeLabel} heading={tomeLabel} className="[&_[cmdk-group-heading]]:text-slate-400">
                                {tomeChapters.map(ch => (
                                    <CommandItem
                                        key={ch.id}
                                        value={`T${ch.tomeNumero} Ch${ch.numero} ${ch.titre || ''} ${ch.tomeNumero} ${ch.numero}`}
                                        onSelect={() => {
                                            onChange(String(ch.id));
                                            setOpen(false);
                                        }}
                                        className="aria-selected:bg-white/10 aria-selected:text-white"
                                    >
                                        <span className="flex w-full items-center gap-2">
                                            <span className="min-w-[3.5rem] font-mono text-xs text-indigo-300">Ch.{ch.numero}</span>
                                            <span className="flex-1 truncate text-slate-200">{ch.titre || <em className="text-slate-500">sans titre</em>}</span>
                                            <span className="text-xs text-slate-500">({(ch.pages || []).length}p)</span>
                                            {String(ch.id) === String(value) && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                                        </span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

function PhaseStepper({ phase }) {
    const steps = [
        { key: 'idle', label: 'Configurer', order: 1 },
        { key: 'processing', label: 'Traitement', order: 2 },
        { key: 'review', label: 'Vérification', order: 3 },
        { key: 'done', label: 'Terminé', order: 4 },
    ];

    const phaseOrder = { idle: 1, 'loading-model': 1, processing: 2, review: 3, done: 4 };
    const currentOrder = phaseOrder[phase] || 1;

    return (
        <div className="flex items-center gap-1.5 sm:gap-2">
            {steps.map((step, idx) => {
                const isDone = currentOrder > step.order;
                const isActive = currentOrder === step.order;
                return (
                    <React.Fragment key={step.key}>
                        <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                            isActive ? 'border-indigo-400/45 bg-indigo-500/20 text-indigo-100 shadow-sm shadow-indigo-950/40'
                            : isDone ? 'border-emerald-400/35 bg-emerald-500/14 text-emerald-200'
                            : 'border-white/12 bg-white/[0.04] text-slate-500'
                        }`}>
                            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                                isActive ? 'bg-indigo-400 text-indigo-950' : isDone ? 'bg-emerald-400 text-emerald-950' : 'bg-white/10 text-slate-400'
                            }`}>
                                {isDone ? <Check className="h-2.5 w-2.5" /> : step.order}
                            </span>
                            <span className="hidden sm:inline">{step.label}</span>
                        </div>
                        {idx < steps.length - 1 && (
                            <div className={`h-px w-4 sm:w-8 ${currentOrder > step.order ? 'bg-emerald-400/40' : 'bg-white/10'}`} />
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
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
    const canUseSuryaBatch = Boolean(ocrProvider === 'local' && tauriLocalOcr.localSuryaModelStatus?.ready);

    const getLocalBatchDisabledReason = () => {
        if (!tauriLocalOcr.isTauri) return "App desktop non detectee.";
        if (!tauriLocalOcr.localModelStatus?.ready) return "Chargez le modele Poneglyph-BBox.";
        if (!tauriLocalOcr.localTextModelStatus?.ready) return "Chargez le modele Poneglyph.";
        return "Inference locale indisponible.";
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
        const useSuryaBatch = Boolean(ocrProvider === 'local' && tauriLocalOcr.localSuryaModelStatus?.ready);

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
                    console.error('Poneglyph failed:', e);
                    lightonTexts.push('');
                }
            }
        } else {
            const lightonPromises = yoloBoxes.map((box) => {
                if (box.w <= 0 || box.h <= 0) return Promise.resolve('');
                return runLightOnClassic(img, box, ocrProvider, tauriLocalOcr).catch(e => {
                    console.error('Poneglyph failed:', e);
                    return '';
                });
            });
            lightonTexts = await Promise.all(lightonPromises);
        }

        let suryaTexts = [];
        if (useSuryaBatch) {
            for (const box of yoloBoxes) {
                if (box.w <= 0 || box.h <= 0) {
                    suryaTexts.push('');
                    continue;
                }
                try {
                    suryaTexts.push(await runSuryaClassic(img, box, tauriLocalOcr));
                } catch (e) {
                    console.error('Surya failed:', e);
                    suryaTexts.push('');
                }
            }
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
            const suryaText = useSuryaBatch ? (suryaTexts[match.yoloBoxIndex] || '') : '';
            const bubbleOrder = match.poneglyphIndex + 1;
            const consensusText = getConsensusText(
                useSuryaBatch
                    ? [poneglyphText, lightonText, suryaText]
                    : [poneglyphText, lightonText]
            );

            if (consensusText) {
                if (hasKnownPageBox(page.id, match.yoloBox)) continue;
                try {
                    const { data: bubble } = await createBubble({
                        id_page: page.id,
                        x: match.yoloBox.x,
                        y: match.yoloBox.y,
                        w: match.yoloBox.w,
                        h: match.yoloBox.h,
                        texte_propose: consensusText,
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
                        suryaText,
                        suryaEnabled: useSuryaBatch,
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
                    suryaText,
                    suryaEnabled: useSuryaBatch,
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
            const suryaText = useSuryaBatch ? (suryaTexts[yoloIdx] || '') : '';
            if (!lightonText && !suryaText) continue;

            const cropBlob = await cropImage(img, yoloBox);
            reviewItems.push({
                pageId: page.id,
                pageNumber: page.numero_page,
                yoloBox,
                poneglyphText: null,
                lightonText,
                suryaText,
                suryaEnabled: useSuryaBatch,
                rallied: false,
                cropUrl: URL.createObjectURL(cropBlob),
                order: poneglyphBubbles.length + ui + 1,
            });
        }

        return { reviewItems, autoValidatedCount };
    };

    const handleChoose = async (item, chosenText) => {
        if (!chosenText || processingReviewRef.current) return;
        const itemKey = getReviewItemKey(item);
        const hadCustomText = Object.prototype.hasOwnProperty.call(customReviewTexts, itemKey);
        const previousCustomText = customReviewTexts[itemKey];

        processingReviewRef.current = true;
        setProcessingReview(true);
        setCustomReviewTexts(prev => {
            const next = { ...prev };
            delete next[itemKey];
            return next;
        });
        setReviewQueue(prev => prev.filter(r => r !== item));
        let shouldRollback = true;

        try {
            if (hasKnownPageBox(item.pageId, item.yoloBox)) {
                shouldRollback = false;
                toast.info("Bulle déjà présente, ignorée.");
                URL.revokeObjectURL(item.cropUrl);
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
            shouldRollback = false;
            await validateBubble(bubble.id);
            URL.revokeObjectURL(item.cropUrl);
            toast.success("Bulle créée et validée !");
        } catch (e) {
            toast.error("Erreur: " + e.message);
            if (shouldRollback) {
                setPhase('review');
                setReviewQueue(prev => {
                    if (prev.some(r => getReviewItemKey(r) === itemKey)) return prev;
                    return [...prev, item].sort((a, b) => {
                        if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
                        return a.order - b.order;
                    });
                });
                if (hadCustomText) {
                    setCustomReviewTexts(prev => ({ ...prev, [itemKey]: previousCustomText }));
                }
            } else {
                URL.revokeObjectURL(item.cropUrl);
            }
        } finally {
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
                const text = getReviewTextBySource(item, source);
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
    const providerLabel = ocrProvider === 'local' ? 'Local' : 'Modal';
    const voterLabel = canUseSuryaBatch ? `${providerLabel} + Surya` : providerLabel;
    const hasSuryaReview = reviewQueue.some(item => item.suryaEnabled && item.suryaText);

    const totalReviewed = stats.totalReview - reviewQueue.length;
    const currentReviewItem = reviewQueue[0] || null;

    return (
        <div className="poneglyph-app -mx-4 -my-6 min-h-screen px-4 py-8 sm:-mx-8 sm:px-8">
            <div className="mx-auto max-w-5xl space-y-5">
                {/* Header */}
                <div className="poneglyph-panel relative overflow-hidden rounded-2xl p-5 sm:p-6">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                            <Link href={`/${params.mangaSlug}/admin?tab=batch`}>
                                <Button variant="outline" size="sm" className="border-white/14 bg-white/8 text-slate-200 hover:bg-white/14 hover:text-white">
                                    <ArrowLeft className="mr-1 h-4 w-4" />
                                    Admin
                                </Button>
                            </Link>
                            <div className="h-8 w-px bg-white/10" />
                            <div className="flex items-center gap-2">
                                <Wand2 className="h-6 w-6 text-[#8dbbff]" />
                                <h1 className="poneglyph-title text-2xl font-extrabold sm:text-3xl">Batch OCR</h1>
                            </div>
                        </div>
                        <PhaseStepper phase={phase} />
                    </div>
                    <p className="poneglyph-muted mt-3 text-sm">Détection, double OCR, puis validation rapide des bulles ambiguës.</p>
                </div>

                {/* Phase: Configure */}
                {(phase === 'idle' || phase === 'loading-model') && (
                    <Card className="poneglyph-panel overflow-hidden rounded-2xl">
                        <CardHeader className="border-b border-white/8 pb-4">
                            <CardTitle className="flex items-center gap-2 text-lg text-white">
                                <Zap className="h-5 w-5 text-indigo-400" />
                                Configuration
                            </CardTitle>
                            <CardDescription className="text-slate-400">
                                Sélectionnez un chapitre. YOLO détecte les bulles, Poneglyph-BBox + Poneglyph font l&apos;OCR, avec Surya en troisième voteur quand il est chargé. Les résultats concordants sont auto-validés.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4 p-5">
                            <div className="grid gap-4 md:grid-cols-[1fr_180px] md:items-end">
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-slate-200">Chapitre</label>
                                    <ChapterCombobox chapters={chapters} value={selectedChapterId} onChange={setSelectedChapterId} />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-slate-200">OCR</label>
                                    <Select value={ocrProvider} onValueChange={handleProviderChange}>
                                        <SelectTrigger className="poneglyph-input h-10 border-white/14 bg-[#040d18]/70">
                                            <SelectValue placeholder="Source OCR" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="modal">
                                                <span className="inline-flex items-center gap-2"><CloudLightning className="h-3.5 w-3.5" /> Modal</span>
                                            </SelectItem>
                                            <SelectItem value="local" disabled={!canUseLocalBatch}>
                                                <span className="inline-flex items-center gap-2"><Cpu className="h-3.5 w-3.5" /> Local</span>
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="font-semibold text-slate-400">État des modèles :</span>
                                    <Badge variant="outline" className="border-white/12 bg-white/8 text-slate-200">Provider : {voterLabel}</Badge>
                                    {tauriLocalOcr.isTauri && <Badge variant="outline" className={tauriLocalOcr.localSuryaModelStatus?.ready ? "border-emerald-400/35 bg-emerald-500/14 text-emerald-200" : "border-white/12 bg-white/8 text-slate-300"}>Surya {tauriLocalOcr.localSuryaModelStatus?.ready ? "chargé" : "non chargé"}</Badge>}
                                    {tauriLocalOcr.isTauri && <Badge variant="outline" className={tauriLocalOcr.localModelStatus?.ready ? "border-emerald-400/35 bg-emerald-500/14 text-emerald-200" : "border-white/12 bg-white/8 text-slate-300"}>Poneglyph-BBox {tauriLocalOcr.localModelStatus?.ready ? "chargé" : "non chargé"}</Badge>}
                                    {tauriLocalOcr.isTauri && <Badge variant="outline" className={tauriLocalOcr.localTextModelStatus?.ready ? "border-emerald-400/35 bg-emerald-500/14 text-emerald-200" : "border-white/12 bg-white/8 text-slate-300"}>Poneglyph {tauriLocalOcr.localTextModelStatus?.ready ? "chargé" : "non chargé"}</Badge>}
                                </div>
                                {tauriLocalOcr.isTauri && !canUseLocalBatch && (
                                    <p className="mt-2 text-[11px] text-slate-400">Mode local disponible quand Poneglyph-BBox et Poneglyph sont tous les deux chargés.</p>
                                )}
                            </div>

                            {phase === 'loading-model' ? (
                                <div className="space-y-3 rounded-xl border border-indigo-400/25 bg-indigo-500/8 p-4">
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="h-4 w-4 animate-spin text-indigo-300" />
                                        <p className="text-sm font-medium text-indigo-100">Chargement du modèle YOLO...</p>
                                    </div>
                                    <Progress value={downloadProgress} />
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs text-slate-400">{downloadProgress}% — téléchargement des modèles de détection</p>
                                        <Button variant="ghost" size="sm" onClick={handleCancel} className="text-slate-400">Annuler</Button>
                                    </div>
                                </div>
                            ) : (
                                <Button
                                    onClick={handleStart}
                                    disabled={!selectedChapterId || (ocrProvider === 'local' && !canUseLocalBatch)}
                                    className="w-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-700 sm:w-auto"
                                >
                                    <Play className="mr-2 h-4 w-4" />
                                    Lancer le batch
                                </Button>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Phase: Processing */}
                {phase === 'processing' && (
                    <Card className="poneglyph-panel rounded-2xl">
                        <CardHeader className="border-b border-white/8 pb-4">
                            <CardTitle className="flex items-center gap-2 text-lg text-white">
                                <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
                                Traitement en cours
                            </CardTitle>
                            <CardDescription className="text-slate-400">Page {progress.current} / {progress.total} · {voterLabel}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4 p-5">
                            <Progress value={(progress.current / progress.total) * 100} />
                            <div className="flex flex-wrap gap-1.5">
                                {pageStatuses.map(ps => (
                                    <div key={ps.id} className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium ${
                                        ps.status === 'done' ? 'border-emerald-400/35 bg-emerald-500/14 text-emerald-200' :
                                        ps.status === 'processing' ? 'border-indigo-400/35 bg-indigo-500/14 text-indigo-200 animate-pulse' :
                                        ps.status === 'error' ? 'border-red-400/35 bg-red-500/14 text-red-200' :
                                        'border-white/12 bg-white/8 text-slate-400'
                                    }`}>
                                        P.{ps.numero}
                                        {ps.status === 'done' && ` ✅${ps.bubbleCount || ''}`}
                                        {ps.status === 'processing' && ' ⏳'}
                                        {ps.status === 'error' && ' ❌'}
                                    </div>
                                ))}
                            </div>
                            <Button variant="ghost" onClick={handleCancel} className="text-red-400 hover:text-red-600">
                                Annuler le traitement
                            </Button>
                        </CardContent>
                    </Card>
                )}

                {/* Phase: Review (focus mode) */}
                {phase === 'review' && currentReviewItem && (
                    <div className="space-y-4">
                        {/* Stats + bulk actions */}
                        <Card className="poneglyph-panel rounded-2xl">
                            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex flex-wrap items-center gap-4">
                                    <div className="flex items-center gap-1.5">
                                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                                        <span className="text-sm font-medium text-slate-200">{stats.autoValidated} auto-validées</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <AlertTriangle className="h-4 w-4 text-amber-400" />
                                        <span className="text-sm font-medium text-slate-200">{reviewQueue.length} à vérifier</span>
                                    </div>
                                    {stats.errors > 0 && (
                                        <div className="flex items-center gap-1.5">
                                            <X className="h-4 w-4 text-red-400" />
                                            <span className="text-sm font-medium text-slate-200">{stats.errors} erreurs</span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    <Button size="sm" variant="outline" onClick={() => handleAcceptAll('lighton')} disabled={processingReview} className="border-white/12 bg-white/8 text-slate-200 hover:bg-white/14">
                                        Tout Poneglyph
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => handleAcceptAll('poneglyph')} disabled={processingReview} className="border-white/12 bg-white/8 text-slate-200 hover:bg-white/14">
                                        Tout Poneglyph-BBox
                                    </Button>
                                    {hasSuryaReview && (
                                        <Button size="sm" variant="outline" onClick={() => handleAcceptAll('surya')} disabled={processingReview} className="border-white/12 bg-white/8 text-slate-200 hover:bg-white/14">
                                            Tout Surya
                                        </Button>
                                    )}
                                    <Button size="sm" variant="ghost" onClick={handleSkipAll} className="text-red-400 hover:text-red-600">
                                        Tout ignorer
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Thumbnail rail */}
                        <div className="flex items-center gap-3">
                            <span className="shrink-0 text-sm font-semibold text-slate-300">{stats.totalReview - reviewQueue.length + 1} / {stats.totalReview}</span>
                            <ScrollArea className="flex-1 whitespace-nowrap">
                                <div className="flex gap-2 pb-1">
                                    {reviewQueue.map((item, idx) => {
                                        const itemKey = getReviewItemKey(item);
                                        const isCurrent = idx === 0;
                                        return (
                                            <button
                                                key={itemKey}
                                                type="button"
                                                onClick={() => {
                                                    setReviewQueue(prev => {
                                                        const target = prev[idx];
                                                        const rest = prev.filter((_, i) => i !== idx);
                                                        return [target, ...rest];
                                                    });
                                                }}
                                                className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-[#040d18] transition-all ${
                                                    isCurrent ? 'border-indigo-400 ring-2 ring-indigo-400/40' : 'border-white/12 opacity-60 hover:opacity-100'
                                                }`}
                                                title={`Page ${item.pageNumber} · #${idx + 1}`}
                                            >
                                                <img src={item.cropUrl} alt={`Bulle ${item.pageNumber}`} className="h-full w-full object-contain" />
                                            </button>
                                        );
                                    })}
                                </div>
                                <ScrollBar orientation="horizontal" />
                            </ScrollArea>
                        </div>

                        {/* Focused review card */}
                        {(() => {
                            const item = currentReviewItem;
                            const itemKey = getReviewItemKey(item);
                            const customText = customReviewTexts[itemKey] ?? getSuggestedReviewText(item);
                            const reviewSources = getReviewSources(item, providerLabel);
                            const diffModel = buildDiffModel(reviewSources);

                            return (
                                <Card key={itemKey} className="overflow-hidden rounded-2xl border-white/12 bg-[#071625]/88 shadow-lg">
                                    <div className="grid gap-0 md:grid-cols-[220px_1fr]">
                                        <div className="flex min-h-52 items-center justify-center border-white/10 bg-[#040d18]/82 p-4 md:border-r">
                                            <img
                                                src={item.cropUrl}
                                                alt={`Bulle page ${item.pageNumber}`}
                                                className="max-h-64 max-w-full object-contain"
                                            />
                                        </div>

                                        <div className="space-y-3 p-5">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge variant="outline" className="border-white/12 bg-white/8 text-slate-200">Page {item.pageNumber}</Badge>
                                                <Badge variant="outline" className="border-white/12 bg-white/8 text-slate-200">Ordre {item.order}</Badge>
                                                {item.rallied ? (
                                                    <Badge className="border-emerald-400/35 bg-emerald-500/14 text-emerald-200">Rallié</Badge>
                                                ) : (
                                                    <Badge className="border-amber-400/35 bg-amber-500/14 text-amber-200">YOLO seul</Badge>
                                                )}
                                                <Badge className={diffModel.allIdentical ? "border-emerald-400/35 bg-emerald-500/14 text-emerald-200" : "border-amber-400/35 bg-amber-500/14 text-amber-200"}>
                                                    {diffModel.label}
                                                </Badge>
                                                {!diffModel.allIdentical && diffModel.changedTokenCount > 0 && (
                                                    <span className="text-xs font-medium text-amber-400/80">{diffModel.changedTokenCount} token{diffModel.changedTokenCount > 1 ? 's' : ''} différent{diffModel.changedTokenCount > 1 ? 's' : ''}</span>
                                                )}
                                            </div>

                                            <div className={`grid gap-2 ${getSourceGridClass(reviewSources.length)}`}>
                                                {reviewSources.map((source, sourceIndex) => (
                                                    <OcrSourceCard
                                                        key={source.key}
                                                        source={source}
                                                        diffFlags={diffModel.flags[sourceIndex]}
                                                        onChoose={(text) => handleChoose(item, text)}
                                                        processingReview={processingReview}
                                                    />
                                                ))}
                                            </div>

                                            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
                                                <p className="mb-2 text-xs font-semibold text-slate-300">Texte à enregistrer</p>
                                                <Textarea
                                                    value={customText}
                                                    onChange={(event) => handleCustomTextChange(item, event.target.value)}
                                                    className="min-h-16 resize-y bg-[#040d18]/86 text-slate-100"
                                                    placeholder="Modifier ou saisir le texte..."
                                                />
                                                <div className="mt-2 flex gap-2">
                                                    <Button
                                                        size="sm"
                                                        className="bg-indigo-600 text-white hover:bg-indigo-700"
                                                        onClick={() => handleChooseCustom(item)}
                                                        disabled={!customText.trim() || processingReview}
                                                    >
                                                        <Check className="mr-1 h-3.5 w-3.5" />
                                                        Valider
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => handleSkip(item)}
                                                        disabled={processingReview}
                                                        className="border-white/12 bg-white/8 text-red-300 hover:bg-white/14 hover:text-red-200"
                                                    >
                                                        <SkipForward className="mr-1 h-3.5 w-3.5" />
                                                        Ignorer
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </Card>
                            );
                        })()}
                    </div>
                )}

                {/* Phase: Done */}
                {phase === 'done' && (
                    <Card className="poneglyph-panel rounded-2xl">
                        <CardHeader className="border-b border-white/8 pb-4">
                            <CardTitle className="flex items-center gap-2 text-lg text-emerald-300">
                                <CheckCircle2 className="h-6 w-6" />
                                Batch terminé !
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4 p-5">
                            <div className="grid grid-cols-3 gap-3">
                                <div className="rounded-xl border border-emerald-400/35 bg-emerald-500/14 p-4 text-center">
                                    <p className="text-2xl font-bold text-emerald-300">{stats.autoValidated}</p>
                                    <p className="text-xs text-emerald-400/80">Auto-validées</p>
                                </div>
                                <div className="rounded-xl border border-indigo-400/35 bg-indigo-500/14 p-4 text-center">
                                    <p className="text-2xl font-bold text-indigo-300">{totalReviewed}</p>
                                    <p className="text-xs text-indigo-400/80">Manuellement validées</p>
                                </div>
                                <div className="rounded-xl border border-white/12 bg-white/[0.06] p-4 text-center">
                                    <p className="text-2xl font-bold text-slate-300">{reviewQueue.length}</p>
                                    <p className="text-xs text-slate-400">Ignorées</p>
                                </div>
                            </div>
                            {stats.errors > 0 && (
                                <p className="flex items-center gap-1 text-sm text-red-400">
                                    <X className="h-3.5 w-3.5" />
                                    {stats.errors} page(s) en erreur
                                </p>
                            )}
                            <Button onClick={handleReset} className="bg-indigo-600 text-white hover:bg-indigo-700">
                                Nouveau batch
                            </Button>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
