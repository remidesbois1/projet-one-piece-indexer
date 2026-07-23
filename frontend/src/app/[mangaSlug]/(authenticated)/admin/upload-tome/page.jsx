"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
import { getTomes, uploadPageToR2, batchCreatePages } from '@/lib/api';
import { analyzeVolumeSummary } from '@/lib/geminiClient';
import { buildPageTypeImportPlan } from '@/lib/pageTypeSlicing';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Trash2,
    Plus,
    Upload,
    CheckCircle2,
    AlertCircle,
    ArrowLeft,
    Loader2,
    X,
    FileArchive,
    Layers,
    MousePointerClick
} from "lucide-react";
import Link from 'next/link';
import { useParams } from 'next/navigation';

const CHAPTER_COLORS = [
    { bg: 'bg-blue-100', border: 'border-blue-400', text: 'text-blue-700', ribbon: 'bg-blue-500' },
    { bg: 'bg-emerald-100', border: 'border-emerald-400', text: 'text-emerald-700', ribbon: 'bg-emerald-500' },
    { bg: 'bg-amber-100', border: 'border-amber-400', text: 'text-amber-700', ribbon: 'bg-amber-500' },
    { bg: 'bg-purple-100', border: 'border-purple-400', text: 'text-purple-700', ribbon: 'bg-purple-500' },
    { bg: 'bg-rose-100', border: 'border-rose-400', text: 'text-rose-700', ribbon: 'bg-rose-500' },
    { bg: 'bg-cyan-100', border: 'border-cyan-400', text: 'text-cyan-700', ribbon: 'bg-cyan-500' },
    { bg: 'bg-orange-100', border: 'border-orange-400', text: 'text-orange-700', ribbon: 'bg-orange-500' },
    { bg: 'bg-indigo-100', border: 'border-indigo-400', text: 'text-indigo-700', ribbon: 'bg-indigo-500' },
];

export default function UploadTomePage() {
    const { session } = useAuth();
    const { mangaSlug } = useManga();
    const params = useParams();

    const [step, setStep] = useState(1);
    const [tomes, setTomes] = useState([]);
    const [selectedTome, setSelectedTome] = useState('');

    const [pages, setPages] = useState([]);
    const [selectedPages, setSelectedPages] = useState(new Set());
    const [lastClickedIndex, setLastClickedIndex] = useState(null);
    const [extracting, setExtracting] = useState(false);
    const [extractProgress, setExtractProgress] = useState(0);
    const [analyzingPageTypes, setAnalyzingPageTypes] = useState(false);
    const [pageTypeProgress, setPageTypeProgress] = useState(0);
    const [analysisStage, setAnalysisStage] = useState('page-type');
    const [pageTypeRuntime, setPageTypeRuntime] = useState(null);
    const [pageTypeError, setPageTypeError] = useState('');
    const [autoRemovedAnnexes, setAutoRemovedAnnexes] = useState([]);
    const [autoChapterCount, setAutoChapterCount] = useState(0);
    const [detectedSummaryPage, setDetectedSummaryPage] = useState(null);
    const pageTypeWorkerRef = useRef(null);
    const pageTypeJobRef = useRef(null);

    const [chapters, setChapters] = useState([]);
    const [assigningChapter, setAssigningChapter] = useState(null);
    const [rangeStart, setRangeStart] = useState(null);

    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadResult, setUploadResult] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (session && mangaSlug) {
            getTomes(mangaSlug).then(res => {
                setTomes(res.data.sort((a, b) => b.numero - a.numero));
            }).catch(() => { });
        }
    }, [session, mangaSlug]);

    useEffect(() => {
        const worker = new Worker(
            new URL('../../../../../workers/pageType.worker.js', import.meta.url),
        );
        pageTypeWorkerRef.current = worker;

        worker.onmessage = ({ data }) => {
            const job = pageTypeJobRef.current;
            if (!job || data.jobId !== job.id) return;

            if (data.type === 'progress') {
                job.predictions.set(data.pageId, data.prediction);
                setPageTypeProgress(Math.round((data.completed / data.total) * 50));
                setPageTypeRuntime(data.runtime);
                setPages((currentPages) => currentPages.map((page) => (
                    page.id === data.pageId ? { ...page, pageType: data.prediction } : page
                )));
                return;
            }

            pageTypeJobRef.current = null;
            if (data.type === 'completed') {
                setPageTypeRuntime(data.runtime);
                job.resolve(job.pages.map((page) => ({
                    ...page,
                    pageType: job.predictions.get(page.id),
                })));
            } else if (data.type === 'error') {
                job.reject(new Error(data.message));
            }
        };

        worker.onerror = (workerError) => {
            const job = pageTypeJobRef.current;
            if (!job) return;
            pageTypeJobRef.current = null;
            job.reject(workerError.error || new Error('Le worker de classification a échoué.'));
        };

        return () => {
            worker.terminate();
            pageTypeWorkerRef.current = null;
            pageTypeJobRef.current?.reject(new Error('Analyse de type de page annulée.'));
            pageTypeJobRef.current = null;
        };
    }, []);

    const classifyExtractedPages = useCallback((extractedPages) => new Promise((resolve, reject) => {
        const worker = pageTypeWorkerRef.current;
        if (!worker) {
            reject(new Error('Le worker de classification est indisponible.'));
            return;
        }
        const id = crypto.randomUUID();
        pageTypeJobRef.current = {
            id,
            pages: extractedPages,
            predictions: new Map(),
            resolve,
            reject,
        };
        worker.postMessage({
            type: 'classify',
            jobId: id,
            pages: extractedPages.map(({ id: pageId, blob }) => ({ id: pageId, blob })),
        });
    }), []);

    const createThumbnail = (blob) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = async () => {
            const thumbH = 300;
            const scale = thumbH / img.height;
            const thumbW = Math.round(img.width * scale);
            const canvas = document.createElement('canvas');
            canvas.width = thumbW;
            canvas.height = thumbH;
            canvas.getContext('2d').drawImage(img, 0, 0, thumbW, thumbH);

            let thumbBlob = await new Promise(r => canvas.toBlob(r, 'image/avif', 0.35));
            if (!thumbBlob) thumbBlob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.35));

            URL.revokeObjectURL(img.src);
            resolve(URL.createObjectURL(thumbBlob));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
    });

    const handleFileSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setExtracting(true);
        setExtractProgress(0);
        setError('');
        setPageTypeError('');
        setPageTypeProgress(0);
        setAnalysisStage('page-type');
        setPageTypeRuntime(null);
        setAutoRemovedAnnexes([]);
        setAutoChapterCount(0);
        setDetectedSummaryPage(null);

        try {
            const { default: JSZip } = await import('jszip');
            const zip = await JSZip.loadAsync(file);
            const imageFiles = [];
            const validExtensions = /\.(jpg|jpeg|png|webp|avif|bmp)$/i;

            zip.forEach((relativePath, entry) => {
                if (!entry.dir && validExtensions.test(relativePath) && !relativePath.includes('__MACOSX')) {
                    imageFiles.push({ path: relativePath, entry });
                }
            });

            imageFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

            const extracted = [];
            for (let i = 0; i < imageFiles.length; i++) {
                const blob = await imageFiles[i].entry.async('blob');
                const thumbUrl = await createThumbnail(blob);
                extracted.push({
                    id: crypto.randomUUID(),
                    index: i,
                    filename: imageFiles[i].path.split('/').pop(),
                    thumbUrl,
                    blob,
                    chapterId: null,
                });
                setExtractProgress(Math.round(((i + 1) / imageFiles.length) * 100));
            }

            setPages(extracted);
            setStep(2);
            setAnalyzingPageTypes(true);

            try {
                const classifiedPages = await classifyExtractedPages(extracted);
                const initialPlan = buildPageTypeImportPlan(classifiedPages);
                setAutoRemovedAnnexes(initialPlan.autoDeletedPages);
                setDetectedSummaryPage(initialPlan.summaryPage);

                if (!initialPlan.summaryPage) {
                    setPages(initialPlan.retainedPages);
                    setPageTypeError(
                        "Aucun sommaire n'a été détecté avec assez de confiance. Les annexes ont été retirées ; définissez les chapitres manuellement.",
                    );
                    return;
                }

                const apiKey = localStorage.getItem('google_api_key');
                if (!apiKey) {
                    setPages(initialPlan.retainedPages);
                    setPageTypeError(
                        "Sommaire détecté, mais la clé API Gemini manque. Configurez-la dans votre profil puis relancez l'import.",
                    );
                    return;
                }

                setAnalysisStage('summary');
                setPageTypeProgress(60);
                const summaryResult = await analyzeVolumeSummary(
                    initialPlan.summaryPage.blob,
                    {
                        pageCount: classifiedPages.length,
                        summaryPage: initialPlan.summaryPage.index + 1,
                    },
                    apiKey,
                );
                setPageTypeProgress(90);
                const plan = buildPageTypeImportPlan(classifiedPages, summaryResult.chapters);
                const assignments = new Map();
                const proposedChapters = plan.chapters.map((proposal, chapterIndex) => {
                    const id = crypto.randomUUID();
                    proposal.pageIds.forEach((pageId) => assignments.set(pageId, id));
                    return {
                        id,
                        numero: proposal.chapterNumber,
                        titre: proposal.title,
                        colorIndex: chapterIndex % CHAPTER_COLORS.length,
                        startPage: proposal.startPage,
                    };
                });
                const chapterStartIds = new Set(proposedChapters.map((chapter) => {
                    const matchingPage = plan.retainedPages.find((page) => page.index === chapter.startPage - 1);
                    return matchingPage?.id;
                }).filter(Boolean));

                setPages(plan.retainedPages.map((page) => ({
                    ...page,
                    chapterId: assignments.get(page.id) || null,
                    suggestedChapterStart: chapterStartIds.has(page.id),
                })));
                setChapters(proposedChapters);
                setAutoRemovedAnnexes(plan.autoDeletedPages);
                setAutoChapterCount(proposedChapters.length);
                setPageTypeProgress(100);
            } catch (analysisError) {
                console.error('Page type analysis error:', analysisError);
                setPageTypeError(
                    "L'analyse du sommaire a échoué. Les annexes détectées ont été retirées ; définissez les chapitres manuellement.",
                );
            } finally {
                setAnalyzingPageTypes(false);
            }
        } catch {
            setError("Erreur lors de l'extraction du fichier. Vérifiez que c'est un CBZ/ZIP valide.");
        } finally {
            setExtracting(false);
        }
    };

    const handlePageClick = useCallback((pageIndex, e) => {
        if (analyzingPageTypes) return;
        if (assigningChapter !== null) {
            if (rangeStart === null) {
                setRangeStart(pageIndex);
            } else {
                const start = Math.min(rangeStart, pageIndex);
                const end = Math.max(rangeStart, pageIndex);
                setPages(prev => prev.map((p, i) => {
                    if (i >= start && i <= end) return { ...p, chapterId: assigningChapter };
                    return p;
                }));
                setRangeStart(null);
                setAssigningChapter(null);
            }
            return;
        }

        setSelectedPages(prev => {
            const next = new Set(prev);
            if (e.shiftKey && lastClickedIndex !== null) {
                const start = Math.min(lastClickedIndex, pageIndex);
                const end = Math.max(lastClickedIndex, pageIndex);
                for (let i = start; i <= end; i++) next.add(i);
            } else if (e.ctrlKey || e.metaKey) {
                if (next.has(pageIndex)) next.delete(pageIndex);
                else next.add(pageIndex);
            } else {
                next.clear();
                next.add(pageIndex);
            }
            return next;
        });
        setLastClickedIndex(pageIndex);
    }, [analyzingPageTypes, assigningChapter, rangeStart, lastClickedIndex]);

    const handleDeleteSelected = () => {
        if (analyzingPageTypes) return;
        if (selectedPages.size === 0) return;
        setPages(prev => prev.filter((_, i) => !selectedPages.has(i)));
        setSelectedPages(new Set());
        setLastClickedIndex(null);
    };

    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key === 'Delete' && selectedPages.size > 0 && step === 2) {
                e.preventDefault();
                handleDeleteSelected();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedPages, step]);

    const addChapter = () => {
        if (analyzingPageTypes) return;
        const maxNum = chapters.reduce((max, c) => Math.max(max, c.numero), 0);
        setChapters(prev => [...prev, {
            id: crypto.randomUUID(),
            numero: maxNum + 1,
            titre: `Chapitre ${maxNum + 1}`,
            colorIndex: prev.length % CHAPTER_COLORS.length,
        }]);
    };

    const removeChapter = (chapterId) => {
        if (analyzingPageTypes) return;
        setChapters(prev => prev.filter(c => c.id !== chapterId));
        setPages(prev => prev.map(p => p.chapterId === chapterId ? { ...p, chapterId: null } : p));
        if (assigningChapter === chapterId) {
            setAssigningChapter(null);
            setRangeStart(null);
        }
    };

    const updateChapter = (chapterId, field, value) => {
        if (analyzingPageTypes) return;
        setChapters(prev => prev.map(c => c.id === chapterId ? { ...c, [field]: value } : c));
    };

    const startAssigning = (chapterId) => {
        if (analyzingPageTypes) return;
        if (assigningChapter === chapterId) {
            setAssigningChapter(null);
            setRangeStart(null);
        } else {
            setAssigningChapter(chapterId);
            setRangeStart(null);
        }
    };

    const getChapterForPage = (page) => {
        if (!page.chapterId) return null;
        return chapters.find(c => c.id === page.chapterId);
    };

    const processAndUpload = async () => {
        const unassigned = pages.filter(p => !p.chapterId);
        if (unassigned.length > 0) {
            setError(`${unassigned.length} page(s) non assignée(s) à un chapitre.`);
            return;
        }
        if (!selectedTome) {
            setError("Veuillez sélectionner un tome.");
            return;
        }

        setUploading(true);
        setUploadProgress(0);
        setError('');

        const totalSteps = pages.length * 2 + 1;
        let currentStep = 0;

        try {
            const processedPages = [];
            setUploadStatus('Traitement des images...');

            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
                const img = new Image();
                const tempUrl = URL.createObjectURL(page.blob);
                img.src = tempUrl;
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                });
                URL.revokeObjectURL(tempUrl);

                const targetHeight = 1500;
                const scale = targetHeight / img.height;
                const targetWidth = Math.round(img.width * scale);

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                let blob;
                const supportsAvif = await new Promise(resolve => {
                    canvas.toBlob(b => resolve(!!b), 'image/avif', 0.35);
                });

                if (supportsAvif) {
                    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/avif', 0.82));
                } else {
                    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
                }

                const chapter = chapters.find(c => c.id === page.chapterId);
                const pageNumInChapter = pages
                    .filter(p => p.chapterId === page.chapterId)
                    .indexOf(page) + 1;

                const ext = supportsAvif ? 'avif' : 'webp';
                const key = `tome-${selectedTome}/chapitre-${chapter.numero}/${pageNumInChapter}.${ext}`;

                processedPages.push({
                    blob,
                    key,
                    contentType: supportsAvif ? 'image/avif' : 'image/webp',
                    chapterId: page.chapterId,
                    pageNum: pageNumInChapter,
                });

                currentStep++;
                setUploadProgress(Math.round((currentStep / totalSteps) * 100));
            }

            setUploadStatus('Téléversement vers le stockage...');
            const uploadedUrls = {};
            const CONCURRENCY = 3;
            for (let i = 0; i < processedPages.length; i += CONCURRENCY) {
                const batch = processedPages.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (page) => {
                    const formData = new FormData();
                    formData.append('file', page.blob, `page.${page.contentType.split('/')[1]}`);
                    formData.append('key', page.key);
                    const { data } = await uploadPageToR2(formData);
                    uploadedUrls[page.key] = data.url;
                }));
                currentStep += batch.length;
                setUploadProgress(Math.round((currentStep / totalSteps) * 100));
            }

            setUploadStatus('Création des entrées en base de données...');

            const chaptersPayload = chapters.map(chapter => {
                const chapterPages = processedPages
                    .filter(p => p.chapterId === chapter.id)
                    .map(p => ({
                        numero_page: p.pageNum,
                        url_image: uploadedUrls[p.key],
                    }));

                return {
                    numero: chapter.numero,
                    titre: chapter.titre,
                    pages: chapterPages,
                };
            });

            const { data: result } = await batchCreatePages({
                tome_id: selectedTome,
                chapters: chaptersPayload,
            });

            setUploadProgress(100);
            setUploadResult(result);
            setStep(3);
        } catch (err) {
            console.error('Upload error:', err);
            setError(err.response?.data?.error || err.message || "Erreur lors du téléversement.");
        } finally {
            setUploading(false);
        }
    };

    const selectedTomeObj = tomes.find(t => String(t.id) === selectedTome);
    const assignedCount = pages.filter(p => p.chapterId).length;
    const assigningChapterObj = chapters.find(c => c.id === assigningChapter);

    return (
        <div className="container mx-auto h-full max-w-7xl space-y-8 overflow-y-auto px-4 py-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-4 border-b border-white/10 pb-6">
                <Link href={`/${params.mangaSlug}/admin?tab=content`}>
                    <Button variant="ghost" size="icon" className="shrink-0">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <h1 className="poneglyph-title text-3xl font-extrabold">
                        Upload Tome
                    </h1>
                    <p className="poneglyph-muted mt-1">
                        Importez un tome complet (.cbz), gérez les pages et assignez-les à des chapitres.
                    </p>
                </div>
            </div>

            <div className="flex items-center gap-2 mb-8">
                {[1, 2, 3].map(s => (
                    <React.Fragment key={s}>
                        <div className={`flex items-center justify-center w-10 h-10 rounded-full font-bold text-sm transition-all duration-300 ${step >= s
                            ? 'bg-[#3d86ff] text-white shadow-lg shadow-[#3d86ff]/20'
                            : 'bg-white/8 text-slate-400'
                            }`}>
                            {step > s ? <CheckCircle2 className="h-5 w-5" /> : s}
                        </div>
                        <span className={`text-sm font-medium ${step >= s ? 'text-slate-200' : 'text-slate-500'}`}>
                            {s === 1 && 'Extraction'}
                            {s === 2 && 'Organisation'}
                            {s === 3 && 'Terminé'}
                        </span>
                        {s < 3 && <div className={`h-0.5 flex-1 rounded ${step > s ? 'bg-[#3d86ff]' : 'bg-white/12'}`} />}
                    </React.Fragment>
                ))}
            </div>

            {error && (
                <Alert variant="destructive" className="animate-in fade-in slide-in-from-top-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {step === 1 && (
                <Card className="poneglyph-panel rounded-xl">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-2xl text-white">
                            <FileArchive className="h-6 w-6 text-[#8dbbff]" />
                            Sélectionner un fichier
                        </CardTitle>
                        <CardDescription className="text-slate-400">
                            Choisissez un fichier .cbz ou .zip contenant les pages du tome.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label className="text-slate-200">Tome cible</Label>
                            <Select value={selectedTome} onValueChange={setSelectedTome}>
                                <SelectTrigger>
                                    <SelectValue placeholder="-- Sélectionner un tome --" />
                                </SelectTrigger>
                                <SelectContent>
                                    {tomes.map(tome => (
                                        <SelectItem key={tome.id} value={String(tome.id)}>
                                            Tome {tome.numero} — {tome.titre}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-slate-200">Fichier source (.cbz / .zip)</Label>
                            <div className="relative">
                                <Input
                                    type="file"
                                    accept=".cbz,.zip"
                                    onChange={handleFileSelect}
                                    disabled={extracting || analyzingPageTypes || !selectedTome}
                                    className="cursor-pointer file:mr-4 file:rounded-full file:border-0 file:bg-[#3d86ff]/18 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-[#bdd6ff] hover:file:bg-[#3d86ff]/28"
                                />
                            </div>
                        </div>

                        {extracting && (
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm text-slate-400">
                                    <span>Extraction en cours...</span>
                                    <span>{extractProgress}%</span>
                                </div>
                                <Progress value={extractProgress} className="h-2" />
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {step === 2 && (
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <h2 className="text-xl font-bold text-white">
                                    Pages ({pages.length})
                                </h2>
                                {assignedCount < pages.length && (
                                    <span className="rounded-full border border-amber-400/35 bg-amber-500/14 px-2 py-1 text-xs font-medium text-amber-200">
                                        {pages.length - assignedCount} non assignée(s)
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {selectedPages.size > 0 && (
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        onClick={handleDeleteSelected}
                                        className="animate-in fade-in zoom-in-95"
                                    >
                                        <Trash2 className="h-4 w-4 mr-1" />
                                        Supprimer ({selectedPages.size})
                                    </Button>
                                )}
                            </div>
                        </div>

                        {analyzingPageTypes && (
                            <Alert className="border-[#3d86ff]/35 bg-[#3d86ff]/10 text-slate-100">
                                <Loader2 className="h-4 w-4 animate-spin text-[#8dbbff]" />
                                <AlertDescription className="space-y-2">
                                    <div className="flex items-center justify-between gap-3 text-sm">
                                        <span>{analysisStage === 'summary'
                                            ? 'Lecture du sommaire par Gemini…'
                                            : 'Analyse locale des pages…'}</span>
                                        <span>{pageTypeProgress}%</span>
                                    </div>
                                    <Progress value={pageTypeProgress} className="h-1.5" />
                                </AlertDescription>
                            </Alert>
                        )}

                        {!analyzingPageTypes && (autoRemovedAnnexes.length > 0 || detectedSummaryPage || autoChapterCount > 0) && (
                            <Alert className="border-emerald-400/35 bg-emerald-500/10 text-slate-100">
                                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                                <AlertDescription className="text-sm text-slate-200">
                                    {autoRemovedAnnexes.length > 0 && (
                                        <span>{autoRemovedAnnexes.length} annexe(s) supprimée(s) automatiquement (confiance &gt; 90 %). </span>
                                    )}
                                    {detectedSummaryPage && (
                                        <span>Sommaire détecté à la page {detectedSummaryPage.index + 1}, envoyé à Gemini. </span>
                                    )}
                                    {autoChapterCount > 0 && (
                                        <span>{autoChapterCount} chapitre(s) pré-assigné(s) depuis le sommaire{pageTypeRuntime ? ` (${pageTypeRuntime.toUpperCase()})` : ''}.</span>
                                    )}
                                </AlertDescription>
                            </Alert>
                        )}

                        {pageTypeError && (
                            <Alert className="border-amber-400/35 bg-amber-500/10 text-amber-100">
                                <AlertCircle className="h-4 w-4" />
                                <AlertDescription>{pageTypeError}</AlertDescription>
                            </Alert>
                        )}

                        {assigningChapter && (
                            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].border
                                } ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].bg} animate-in fade-in slide-in-from-top-2`}>
                                <MousePointerClick className={`h-5 w-5 ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].text}`} />
                                <p className={`text-sm font-medium ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].text}`}>
                                    {rangeStart === null
                                        ? `Cliquez sur la première page pour "${assigningChapterObj?.titre}"`
                                        : `Cliquez sur la dernière page du range (début: page ${rangeStart + 1})`
                                    }
                                </p>
                                <Button variant="ghost" size="sm" onClick={() => { setAssigningChapter(null); setRangeStart(null); }}>
                                    <X className="h-4 w-4" /> Annuler
                                </Button>
                            </div>
                        )}

                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                            {pages.map((page, index) => {
                                const chapter = getChapterForPage(page);
                                const colorSet = chapter ? CHAPTER_COLORS[chapter.colorIndex] : null;
                                const isSelected = selectedPages.has(index);
                                const isRangeStart = assigningChapter && rangeStart === index;

                                return (
                                    <div
                                        key={page.id}
                                        onClick={(e) => handlePageClick(index, e)}
                                        className={`relative group cursor-pointer rounded-xl overflow-hidden border-2 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 ${isRangeStart
                                            ? 'border-yellow-400 ring-2 ring-yellow-300 shadow-lg shadow-yellow-100'
                                            : isSelected
                                                ? 'border-blue-500 ring-2 ring-blue-300 shadow-lg shadow-blue-100'
                                                : colorSet
                                                    ? `${colorSet.border} ${colorSet.bg}`
                                                    : 'border-white/12 bg-white/[0.055] hover:border-[#8dbbff]/38'
                                            }`}
                                    >
                                        {colorSet && (
                                            <div className={`absolute top-0 left-0 right-0 h-1 ${colorSet.ribbon} z-10`} />
                                        )}

                                        <div className="relative aspect-[2/3] overflow-hidden bg-[#040d18]">
                                            <img
                                                src={page.thumbUrl}
                                                alt={`Page ${index + 1}`}
                                                className="w-full h-full object-cover"
                                                loading="lazy"
                                            />
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                            {page.suggestedChapterStart && (
                                                <span className="absolute left-1.5 top-1.5 rounded bg-[#3d86ff] px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
                                                    Début du sommaire
                                                </span>
                                            )}
                                        </div>

                                        <div className="border-t border-white/10 bg-[#071625]/92 px-2 py-1.5 backdrop-blur-sm">
                                            <p className="truncate text-center text-xs font-semibold text-slate-200">
                                                {index + 1}
                                                {chapter && (
                                                    <span className={`ml-1 ${colorSet.text}`}>
                                                        · Ch.{chapter.numero}
                                                    </span>
                                                )}
                                            </p>
                                        </div>

                                        {isSelected && (
                                            <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold shadow-lg">
                                                ✓
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="space-y-4">
                        <Card className="poneglyph-panel sticky top-24 flex max-h-[calc(100vh-8rem)] flex-col rounded-xl">
                            <CardHeader className="pb-4">
                                <CardTitle className="flex items-center gap-2 text-lg">
                                    <Layers className="h-5 w-5 text-[#8dbbff]" />
                                    Chapitres
                                </CardTitle>
                                <CardDescription className="text-sm">
                                    Définissez les chapitres et assignez-leur des plages de pages.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 overflow-y-auto flex-1">
                                {selectedTomeObj && (
                                    <div className="rounded-lg border border-white/12 bg-white/[0.06] px-3 py-2 text-sm text-slate-300">
                                        📖 Tome {selectedTomeObj.numero} — {selectedTomeObj.titre}
                                    </div>
                                )}

                                {chapters.length === 0 && (
                                    <div className="text-center py-6 text-slate-400">
                                        <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
                                        <p className="text-sm">Aucun chapitre défini</p>
                                    </div>
                                )}

                                {chapters.map(chapter => {
                                    const colorSet = CHAPTER_COLORS[chapter.colorIndex];
                                    const chapterPages = pages.filter(p => p.chapterId === chapter.id);
                                    const isAssigning = assigningChapter === chapter.id;

                                    return (
                                        <div
                                            key={chapter.id}
                                            className={`rounded-xl border-2 p-3 space-y-2 transition-all ${isAssigning
                                                ? `${colorSet.border} ${colorSet.bg} shadow-md`
                                                : 'border-white/12 bg-white/[0.055] hover:border-[#8dbbff]/38'
                                                }`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <div className={`w-3 h-3 rounded-full ${colorSet.ribbon}`} />
                                                <Input
                                                    value={chapter.numero}
                                                    onChange={(e) => updateChapter(chapter.id, 'numero', parseInt(e.target.value) || 0)}
                                                    className="w-16 h-8 text-xs font-bold text-center"
                                                    type="number"
                                                />
                                                <Input
                                                    value={chapter.titre}
                                                    onChange={(e) => updateChapter(chapter.id, 'titre', e.target.value)}
                                                    className="flex-1 h-8 text-xs"
                                                    placeholder="Titre"
                                                />
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8 text-slate-400 hover:text-red-500"
                                                    onClick={() => removeChapter(chapter.id)}
                                                >
                                                    <X className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>

                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-slate-400">
                                                    {chapterPages.length} page(s)
                                                </span>
                                                <Button
                                                    variant={isAssigning ? "default" : "outline"}
                                                    size="sm"
                                                    className={`h-7 text-xs ${isAssigning ? colorSet.ribbon + ' text-white' : ''}`}
                                                    onClick={() => startAssigning(chapter.id)}
                                                >
                                                    <MousePointerClick className="h-3 w-3 mr-1" />
                                                    {isAssigning ? 'Assignation...' : 'Assigner pages'}
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}

                                <Button
                                    variant="outline"
                                    className="w-full border-dashed border-slate-300 hover:border-slate-400"
                                    onClick={addChapter}
                                >
                                    <Plus className="h-4 w-4 mr-2" />
                                    Ajouter un chapitre
                                </Button>

                                <div className="border-t border-white/12 pt-4">
                                    <Button
                                        className="w-full bg-slate-900 hover:bg-slate-800 text-white shadow-lg"
                                        size="lg"
                                        disabled={uploading || analyzingPageTypes || chapters.length === 0 || assignedCount < pages.length}
                                        onClick={processAndUpload}
                                    >
                                        {uploading ? (
                                            <>
                                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                {uploadStatus}
                                            </>
                                        ) : (
                                            <>
                                                <Upload className="h-4 w-4 mr-2" />
                                                Traiter & Uploader ({pages.length} pages)
                                            </>
                                        )}
                                    </Button>

                                    {uploading && (
                                        <div className="mt-3 space-y-1">
                                            <Progress value={uploadProgress} className="h-2" />
                                            <p className="text-center text-xs text-slate-400">{uploadProgress}%</p>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {step === 3 && (
                <Card className="poneglyph-panel mx-auto max-w-2xl rounded-xl">
                    <CardContent className="py-12 text-center space-y-6">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/35 bg-emerald-500/14">
                            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-white">Upload terminé !</h2>
                            <p className="mt-2 text-slate-400">
                                {uploadResult?.message || "Toutes les pages ont été traitées et uploadées avec succès."}
                            </p>
                        </div>

                        {uploadResult?.results && (
                            <div className="space-y-2 rounded-xl border border-white/12 bg-white/[0.06] p-4 text-left">
                                {uploadResult.results.map((r, i) => (
                                    <div key={i} className="flex items-center justify-between text-sm">
                                        <span className="font-medium text-slate-200">Chapitre {r.numero}</span>
                                        {r.error ? (
                                            <span className="text-red-500 text-xs">{r.error}</span>
                                        ) : (
                                            <span className="text-emerald-600">{r.pages} pages ✓</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex gap-3 justify-center pt-4">
                            <Link href={`/${params.mangaSlug}/admin?tab=content`}>
                                <Button variant="outline">
                                    <ArrowLeft className="h-4 w-4 mr-2" />
                                    Retour admin
                                </Button>
                            </Link>
                            <Button onClick={() => { setStep(1); setPages([]); setChapters([]); setUploadResult(null); setSelectedTome(''); }}>
                                <Plus className="h-4 w-4 mr-2" />
                                Nouveau tome
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
