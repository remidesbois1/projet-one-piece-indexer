"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
import { getTomes, uploadPageToR2, batchCreatePages } from '@/lib/api';
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
    BookOpen,
    Trash2,
    Plus,
    Upload,
    CheckCircle2,
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Loader2,
    X,
    FileArchive,
    Layers,
    MousePointerClick,
    GripVertical
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

        try {
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
        } catch (err) {
            setError("Erreur lors de l'extraction du fichier. Vérifiez que c'est un CBZ/ZIP valide.");
        } finally {
            setExtracting(false);
        }
    };

    const handlePageClick = useCallback((pageIndex, e) => {
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
    }, [assigningChapter, rangeStart, lastClickedIndex]);

    const handleDeleteSelected = () => {
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
        const maxNum = chapters.reduce((max, c) => Math.max(max, c.numero), 0);
        setChapters(prev => [...prev, {
            id: crypto.randomUUID(),
            numero: maxNum + 1,
            titre: `Chapitre ${maxNum + 1}`,
            colorIndex: prev.length % CHAPTER_COLORS.length,
        }]);
    };

    const removeChapter = (chapterId) => {
        setChapters(prev => prev.filter(c => c.id !== chapterId));
        setPages(prev => prev.map(p => p.chapterId === chapterId ? { ...p, chapterId: null } : p));
        if (assigningChapter === chapterId) {
            setAssigningChapter(null);
            setRangeStart(null);
        }
    };

    const updateChapter = (chapterId, field, value) => {
        setChapters(prev => prev.map(c => c.id === chapterId ? { ...c, [field]: value } : c));
    };

    const startAssigning = (chapterId) => {
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
        <div className="container max-w-7xl mx-auto py-10 px-4 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-4 pb-6 border-b border-slate-200">
                <Link href={`/${params.mangaSlug}/admin?tab=content`}>
                    <Button variant="ghost" size="icon" className="shrink-0">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
                        Upload Tome
                    </h1>
                    <p className="text-slate-500 mt-1">
                        Importez un tome complet (.cbz), gérez les pages et assignez-les à des chapitres.
                    </p>
                </div>
            </div>

            <div className="flex items-center gap-2 mb-8">
                {[1, 2, 3].map(s => (
                    <React.Fragment key={s}>
                        <div className={`flex items-center justify-center w-10 h-10 rounded-full font-bold text-sm transition-all duration-300 ${step >= s
                            ? 'bg-slate-900 text-white shadow-lg shadow-slate-900/20'
                            : 'bg-slate-100 text-slate-400'
                            }`}>
                            {step > s ? <CheckCircle2 className="h-5 w-5" /> : s}
                        </div>
                        <span className={`text-sm font-medium ${step >= s ? 'text-slate-700' : 'text-slate-400'}`}>
                            {s === 1 && 'Extraction'}
                            {s === 2 && 'Organisation'}
                            {s === 3 && 'Terminé'}
                        </span>
                        {s < 3 && <div className={`flex-1 h-0.5 rounded ${step > s ? 'bg-slate-900' : 'bg-slate-200'}`} />}
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
                <Card className="border-slate-200 shadow-xl shadow-slate-200/50">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-2xl">
                            <FileArchive className="h-6 w-6 text-slate-700" />
                            Sélectionner un fichier
                        </CardTitle>
                        <CardDescription>
                            Choisissez un fichier .cbz ou .zip contenant les pages du tome.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label>Tome cible</Label>
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
                            <Label>Fichier source (.cbz / .zip)</Label>
                            <div className="relative">
                                <Input
                                    type="file"
                                    accept=".cbz,.zip"
                                    onChange={handleFileSelect}
                                    disabled={extracting || !selectedTome}
                                    className="cursor-pointer file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                                />
                            </div>
                        </div>

                        {extracting && (
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm text-slate-500">
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
                                <h2 className="text-xl font-bold text-slate-900">
                                    Pages ({pages.length})
                                </h2>
                                {assignedCount < pages.length && (
                                    <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-1 rounded-full border border-amber-200">
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
                                                    : 'border-slate-200 hover:border-slate-300'
                                            }`}
                                    >
                                        {colorSet && (
                                            <div className={`absolute top-0 left-0 right-0 h-1 ${colorSet.ribbon} z-10`} />
                                        )}

                                        <div className="aspect-[2/3] bg-slate-50 relative overflow-hidden">
                                            <img
                                                src={page.thumbUrl}
                                                alt={`Page ${index + 1}`}
                                                className="w-full h-full object-cover"
                                                loading="lazy"
                                            />
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </div>

                                        <div className="px-2 py-1.5 bg-white/90 backdrop-blur-sm">
                                            <p className="text-xs font-semibold text-slate-700 text-center truncate">
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
                        <Card className="border-slate-200 shadow-lg sticky top-24 max-h-[calc(100vh-8rem)] flex flex-col">
                            <CardHeader className="pb-4">
                                <CardTitle className="flex items-center gap-2 text-lg">
                                    <Layers className="h-5 w-5 text-slate-600" />
                                    Chapitres
                                </CardTitle>
                                <CardDescription className="text-sm">
                                    Définissez les chapitres et assignez-leur des plages de pages.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 overflow-y-auto flex-1">
                                {selectedTomeObj && (
                                    <div className="text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
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
                                                : 'border-slate-200 hover:border-slate-300'
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
                                                <span className="text-xs text-slate-500">
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

                                <div className="pt-4 border-t border-slate-200">
                                    <Button
                                        className="w-full bg-slate-900 hover:bg-slate-800 text-white shadow-lg"
                                        size="lg"
                                        disabled={uploading || chapters.length === 0 || assignedCount < pages.length}
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
                                            <p className="text-xs text-slate-500 text-center">{uploadProgress}%</p>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {step === 3 && (
                <Card className="border-slate-200 shadow-xl max-w-2xl mx-auto">
                    <CardContent className="py-12 text-center space-y-6">
                        <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
                            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-slate-900">Upload terminé !</h2>
                            <p className="text-slate-500 mt-2">
                                {uploadResult?.message || "Toutes les pages ont été traitées et uploadées avec succès."}
                            </p>
                        </div>

                        {uploadResult?.results && (
                            <div className="text-left bg-slate-50 rounded-xl p-4 space-y-2">
                                {uploadResult.results.map((r, i) => (
                                    <div key={i} className="flex items-center justify-between text-sm">
                                        <span className="font-medium text-slate-700">Chapitre {r.numero}</span>
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
