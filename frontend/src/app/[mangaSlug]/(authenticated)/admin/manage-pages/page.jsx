"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useManga } from '@/context/MangaContext';
import {
    getAdminHierarchy,
    updateColorCrop,
    validateColor,
    uploadColorVariant,
    deleteColorVariant,
    uploadPageToR2,
} from '@/lib/api';
import { initAlignmentWorker, alignPages, terminateAlignmentWorker, applyTransformToCanvas } from '@/lib/colorAlign';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    BookOpen,
    ChevronRight,
    Layers,
    Loader2,
    ImageOff,
    Palette,
    Check,
    X,
    RotateCcw,
    Upload,
    Trash2,
    Eye,
    ArrowLeft,
    ArrowRight,
    Move,
    CheckCircle2,
    AlertCircle,
    Info,
} from "lucide-react";
import Image from "next/image";
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { cn, getProxiedImageUrl } from "@/lib/utils";

// ── helpers ──────────────────────────────────────────────────────────────────

function getColorStats(pages) {
    const total = pages.length;
    const withColor = pages.filter(p => p.url_image_color).length;
    const validated = pages.filter(p => p.url_image_color && p.color_validated).length;
    return { total, withColor, validated };
}

function getChapterColorStats(chapter) {
    return getColorStats(chapter.pages || []);
}

function getTomeColorStats(tome) {
    const allPages = (tome.chapitres || []).flatMap(c => c.pages || []);
    return getColorStats(allPages);
}

// ── component ────────────────────────────────────────────────────────────────

export default function ManagePagesPage() {
    const { currentManga, mangaSlug } = useManga();
    const params = useParams();
    const pageTitle = currentManga ? `Pages Couleur : ${currentManga.titre}` : "Gestion Pages Couleur";

    // ─ hierarchy state ─
    const [hierarchy, setHierarchy] = useState([]);
    const [loading, setLoading] = useState(true);

    // ─ selection state ─
    const [selectedTome, setSelectedTome] = useState(null);
    const [selectedChapter, setSelectedChapter] = useState(null);
    const [selectedPage, setSelectedPage] = useState(null);

    // ─ alignment state ─
    const [previewMode, setPreviewMode] = useState('side'); // 'side' | 'overlay' | 'diff'
    const [overlayOpacity, setOverlayOpacity] = useState(0.5);
    const [manualOffsetX, setManualOffsetX] = useState(0);
    const [manualOffsetY, setManualOffsetY] = useState(0);
    const [isAligning, setIsAligning] = useState(false);
    const [alignProgress, setAlignProgress] = useState(null);

    // ─ upload state ─
    const [uploadingColor, setUploadingColor] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);

    // ─ action feedback ─
    const [actionMsg, setActionMsg] = useState(null); // { type: 'success'|'error', text: '...' }

    // ─ canvas refs for preview ─
    const previewCanvasRef = useRef(null);
    const bwCanvasRef = useRef(null);
    const colorCanvasRef = useRef(null);

    // ── load hierarchy ──────────────────────────────────────────────────────
    useEffect(() => {
        loadHierarchy();
        return () => terminateAlignmentWorker();
    }, []);

    const loadHierarchy = async () => {
        setLoading(true);
        try {
            const res = await getAdminHierarchy();
            setHierarchy(res.data);
        } catch (err) {
            console.error("Error loading hierarchy:", err);
        } finally {
            setLoading(false);
        }
    };

    // clear action messages after 4s
    useEffect(() => {
        if (actionMsg) {
            const t = setTimeout(() => setActionMsg(null), 4000);
            return () => clearTimeout(t);
        }
    }, [actionMsg]);

    // ── selection handlers ──────────────────────────────────────────────────

    const handleTomeClick = (tome) => {
        if (selectedTome?.id === tome.id) {
            setSelectedTome(null);
            setSelectedChapter(null);
            setSelectedPage(null);
        } else {
            setSelectedTome(tome);
            setSelectedChapter(null);
            setSelectedPage(null);
        }
    };

    const handleChapterClick = (chapter, e) => {
        e.stopPropagation();
        setSelectedChapter(chapter);
        setSelectedPage(null);
    };

    const handlePageSelect = (page) => {
        setSelectedPage(page);
        // Reset manual offsets when selecting a new page
        const crop = page.color_crop_data;
        setManualOffsetX(crop?.manual_offset_x || 0);
        setManualOffsetY(crop?.manual_offset_y || 0);
    };

    // ── navigate between pages ──────────────────────────────────────────────

    const navigatePage = useCallback((direction) => {
        if (!selectedChapter || !selectedPage) return;
        const pages = selectedChapter.pages;
        const idx = pages.findIndex(p => p.id === selectedPage.id);
        const newIdx = idx + direction;
        if (newIdx >= 0 && newIdx < pages.length) {
            handlePageSelect(pages[newIdx]);
        }
    }, [selectedChapter, selectedPage]);

    // keyboard navigation
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                navigatePage(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                navigatePage(1);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [navigatePage]);

    // ── alignment ───────────────────────────────────────────────────────────

    const runAlignment = async () => {
        if (!selectedPage || !selectedPage.url_image || !selectedPage.url_image_color) return;

        setIsAligning(true);
        setAlignProgress('Chargement OpenCV...');

        try {
            await initAlignmentWorker();
            setAlignProgress('Chargement des images...');

            // Load both images
            const [bwImageData, colorImageData] = await Promise.all([
                loadImageDataFromUrl(getProxiedImageUrl(selectedPage.url_image)),
                loadImageDataFromUrl(getProxiedImageUrl(selectedPage.url_image_color)),
            ]);

            setAlignProgress('Alignement en cours...');

            const result = await alignPages(bwImageData, colorImageData, selectedPage.id, (progress) => {
                setAlignProgress(progress.step || 'Alignement...');
            });

            // Save crop data to backend
            const cropData = {
                affine: result.transform,
                manual_offset_x: 0,
                manual_offset_y: 0,
            };

            await updateColorCrop(selectedPage.id, cropData);

            // Update local state
            updatePageInHierarchy(selectedPage.id, {
                color_crop_data: cropData,
                color_validated: false,
            });

            setManualOffsetX(0);
            setManualOffsetY(0);
            setActionMsg({ type: 'success', text: `Alignement terminé (${result.stats?.inliers || '?'} points)` });

        } catch (err) {
            console.error('Alignment error:', err);
            setActionMsg({ type: 'error', text: `Erreur: ${err.message}` });
        } finally {
            setIsAligning(false);
            setAlignProgress(null);
        }
    };

    // ── validate ────────────────────────────────────────────────────────────

    const handleValidate = async (validated = true) => {
        if (!selectedPage) return;
        try {
            // If there are manual offsets, save them first
            if (manualOffsetX !== 0 || manualOffsetY !== 0) {
                const currentCrop = selectedPage.color_crop_data || {};
                const updatedCrop = {
                    ...currentCrop,
                    manual_offset_x: manualOffsetX,
                    manual_offset_y: manualOffsetY,
                };
                await updateColorCrop(selectedPage.id, updatedCrop);
                updatePageInHierarchy(selectedPage.id, { color_crop_data: updatedCrop });
            }

            await validateColor(selectedPage.id, validated);
            updatePageInHierarchy(selectedPage.id, { color_validated: validated });
            setActionMsg({ type: 'success', text: validated ? 'Alignement validé' : 'Validation retirée' });
        } catch (err) {
            console.error('Validate error:', err);
            setActionMsg({ type: 'error', text: `Erreur: ${err.message}` });
        }
    };

    // ── upload color for a single page ──────────────────────────────────────

    const handleUploadColor = async (e) => {
        const file = e.target.files?.[0];
        if (!file || !selectedPage) return;

        setUploadingColor(true);
        setUploadProgress(0);

        try {
            // Process: resize to 1500px height + AVIF client-side, then upload
            const img = await loadImageFromFile(file);
            const targetHeight = 1500;
            const scale = targetHeight / img.height;
            const targetWidth = Math.round(img.width * scale);

            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            canvas.getContext('2d').drawImage(img, 0, 0, targetWidth, targetHeight);

            // Try AVIF, fallback to WebP
            let blob = await new Promise(r => canvas.toBlob(r, 'image/avif', 0.82));
            let ext = 'avif';
            if (!blob) {
                blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.85));
                ext = 'webp';
            }

            setUploadProgress(30);

            const formData = new FormData();
            formData.append('file', blob, `color-page.${ext}`);

            const { data } = await uploadColorVariant(selectedPage.id, formData);
            setUploadProgress(100);

            updatePageInHierarchy(selectedPage.id, {
                url_image_color: data.url_image_color,
                color_crop_data: data.color_crop_data,
                color_validated: data.color_validated,
                color_source_pages: data.color_source_pages,
            });

            setActionMsg({ type: 'success', text: 'Variante couleur uploadée' });
        } catch (err) {
            console.error('Upload color error:', err);
            setActionMsg({ type: 'error', text: `Erreur upload: ${err.message}` });
        } finally {
            setUploadingColor(false);
            setUploadProgress(0);
            // Reset file input
            e.target.value = '';
        }
    };

    // ── delete color ────────────────────────────────────────────────────────

    const handleDeleteColor = async () => {
        if (!selectedPage?.url_image_color) return;
        if (!confirm('Supprimer la variante couleur de cette page ?')) return;

        try {
            await deleteColorVariant(selectedPage.id);
            updatePageInHierarchy(selectedPage.id, {
                url_image_color: null,
                color_crop_data: null,
                color_validated: false,
                color_source_pages: null,
            });
            setActionMsg({ type: 'success', text: 'Variante couleur supprimée' });
        } catch (err) {
            console.error('Delete color error:', err);
            setActionMsg({ type: 'error', text: `Erreur: ${err.message}` });
        }
    };

    // ── utility: update page in local hierarchy state ────────────────────────

    const updatePageInHierarchy = useCallback((pageId, updates) => {
        setHierarchy(prev => prev.map(tome => ({
            ...tome,
            chapitres: tome.chapitres.map(chap => ({
                ...chap,
                pages: chap.pages.map(p =>
                    p.id === pageId ? { ...p, ...updates } : p
                )
            }))
        })));

        // Also update selectedPage if it matches
        setSelectedPage(prev => {
            if (prev && prev.id === pageId) return { ...prev, ...updates };
            return prev;
        });

        // Also update selectedChapter pages
        setSelectedChapter(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                pages: prev.pages.map(p =>
                    p.id === pageId ? { ...p, ...updates } : p
                )
            };
        });
    }, []);

    // ── image loading helpers ───────────────────────────────────────────────

    async function loadImageDataFromUrl(url) {
        const img = await new Promise((resolve, reject) => {
            const image = new window.Image();
            image.crossOrigin = 'anonymous';
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = url;
        });

        const maxH = 1500;
        const scale = maxH / img.height;
        const w = Math.round(img.width * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = maxH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, maxH);
        return ctx.getImageData(0, 0, w, maxH);
    }

    function loadImageFromFile(file) {
        return new Promise((resolve, reject) => {
            const img = new window.Image();
            const url = URL.createObjectURL(file);
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
            img.src = url;
        });
    }

    // ── derived values ──────────────────────────────────────────────────────

    const hasColor = !!selectedPage?.url_image_color;
    const hasCropData = !!selectedPage?.color_crop_data?.affine;
    const isValidated = !!selectedPage?.color_validated;

    const currentPageIdx = selectedChapter?.pages?.findIndex(p => p.id === selectedPage?.id) ?? -1;
    const canGoPrev = currentPageIdx > 0;
    const canGoNext = selectedChapter ? currentPageIdx < selectedChapter.pages.length - 1 : false;

    // ── RENDER ──────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-[calc(100vh-3.5rem)]">
            {pageTitle && <title>{pageTitle}</title>}

            {/* Top bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b bg-white shrink-0">
                <div className="flex items-center gap-3">
                    <Link href={`/${params.mangaSlug}/admin?tab=content`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                    </Link>
                    <div className="flex items-center gap-2">
                        <Palette className="h-5 w-5 text-rose-500" />
                        <h1 className="text-lg font-bold tracking-tight text-slate-900">
                            Gestion Pages Couleur
                        </h1>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {actionMsg && (
                        <div className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium animate-in fade-in slide-in-from-right-2",
                            actionMsg.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'
                        )}>
                            {actionMsg.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                            {actionMsg.text}
                        </div>
                    )}
                </div>
            </div>

            {/* Main 3-column layout */}
            <div className="flex-1 flex overflow-hidden min-h-0">

                {/* ── Column 1: Tome/Chapter tree ── */}
                <div className="w-[260px] min-w-[220px] border-r bg-slate-50 flex flex-col min-h-0">
                    <div className="p-3 font-semibold text-slate-700 border-b bg-slate-100 text-sm shrink-0">
                        Volumes
                    </div>
                    <ScrollArea className="flex-1 h-full">
                        {loading ? (
                            <div className="p-4 flex justify-center">
                                <Loader2 className="animate-spin h-6 w-6 text-slate-400" />
                            </div>
                        ) : (
                            <div className="p-2 space-y-1">
                                {hierarchy.map(tome => {
                                    const tomeStats = getTomeColorStats(tome);
                                    const isSelected = selectedTome?.id === tome.id;

                                    return (
                                        <div key={tome.id} className="space-y-1">
                                            <button
                                                onClick={() => handleTomeClick(tome)}
                                                className={cn(
                                                    "w-full flex items-center justify-between p-2 rounded-md text-sm transition-colors",
                                                    isSelected
                                                        ? "bg-blue-100 text-blue-700 font-medium"
                                                        : "hover:bg-slate-200 text-slate-700"
                                                )}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <BookOpen className="h-4 w-4 shrink-0" />
                                                    <span className="truncate">Tome {tome.numero}</span>
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    {tomeStats.withColor > 0 && (
                                                        <Badge variant="secondary" className={cn(
                                                            "text-[9px] h-4 px-1",
                                                            tomeStats.validated === tomeStats.withColor
                                                                ? "bg-emerald-100 text-emerald-700"
                                                                : "bg-rose-100 text-rose-700"
                                                        )}>
                                                            <Palette className="h-2.5 w-2.5 mr-0.5" />
                                                            {tomeStats.validated}/{tomeStats.withColor}
                                                        </Badge>
                                                    )}
                                                    {isSelected && <ChevronRight className="h-3.5 w-3.5" />}
                                                </div>
                                            </button>

                                            {isSelected && (
                                                <div className="ml-4 pl-2 border-l-2 border-slate-200 space-y-1 mt-1">
                                                    {tome.chapitres.map(chap => {
                                                        const chapStats = getChapterColorStats(chap);
                                                        const isChapSelected = selectedChapter?.id === chap.id;

                                                        return (
                                                            <button
                                                                key={chap.id}
                                                                onClick={(e) => handleChapterClick(chap, e)}
                                                                className={cn(
                                                                    "w-full flex items-center justify-between p-2 rounded-md text-sm transition-colors text-left",
                                                                    isChapSelected
                                                                        ? "bg-white shadow-sm text-blue-600 ring-1 ring-blue-100"
                                                                        : "hover:bg-white/50 text-slate-600"
                                                                )}
                                                            >
                                                                <span className="truncate">Ch. {chap.numero}</span>
                                                                <div className="flex items-center gap-1">
                                                                    <Badge variant="secondary" className="text-[9px] h-4 px-1">
                                                                        {chapStats.total} p
                                                                    </Badge>
                                                                    {chapStats.withColor > 0 && (
                                                                        <Badge variant="secondary" className={cn(
                                                                            "text-[9px] h-4 px-1",
                                                                            chapStats.validated === chapStats.withColor
                                                                                ? "bg-emerald-100 text-emerald-700"
                                                                                : "bg-amber-100 text-amber-700"
                                                                        )}>
                                                                            {chapStats.validated}/{chapStats.withColor}
                                                                        </Badge>
                                                                    )}
                                                                </div>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </ScrollArea>
                </div>

                {/* ── Column 2: Page grid ── */}
                <div className="w-[300px] min-w-[250px] border-r bg-white flex flex-col min-h-0">
                    <div className="p-3 font-semibold text-slate-700 border-b bg-slate-50 flex justify-between items-center text-sm shrink-0">
                        <span>Pages</span>
                        {selectedChapter && (
                            <span className="text-xs font-normal text-slate-500">
                                Ch. {selectedChapter.numero}
                            </span>
                        )}
                    </div>
                    <ScrollArea className="flex-1 h-full">
                        {!selectedChapter ? (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
                                <BookOpen className="h-10 w-10 mb-2 opacity-20" />
                                <p className="text-sm">Sélectionnez un chapitre</p>
                            </div>
                        ) : (
                            <div className="p-2 grid grid-cols-2 gap-2">
                                {selectedChapter.pages.map(page => {
                                    const isPageSelected = selectedPage?.id === page.id;
                                    const pageHasColor = !!page.url_image_color;
                                    const pageValidated = pageHasColor && page.color_validated;
                                    const pageHasCrop = pageHasColor && !!page.color_crop_data?.affine;

                                    return (
                                        <button
                                            key={page.id}
                                            onClick={() => handlePageSelect(page)}
                                            className={cn(
                                                "flex flex-col items-center p-1.5 rounded-lg border-2 transition-all relative overflow-hidden group",
                                                isPageSelected
                                                    ? "border-blue-500 bg-blue-50/30 ring-1 ring-blue-300 shadow-md"
                                                    : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
                                            )}
                                        >
                                            {/* B&W thumbnail */}
                                            <div className="w-full aspect-[2/3] bg-slate-100 rounded overflow-hidden relative">
                                                {page.url_image ? (
                                                    <Image
                                                        src={getProxiedImageUrl(page.url_image)}
                                                        alt={`Page ${page.numero_page}`}
                                                        fill
                                                        sizes="150px"
                                                        className="object-cover"
                                                        loading="lazy"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <ImageOff className="h-5 w-5 text-slate-300" />
                                                    </div>
                                                )}

                                                {/* Color status indicator */}
                                                <div className={cn(
                                                    "absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold shadow",
                                                    pageValidated
                                                        ? 'bg-emerald-500'
                                                        : pageHasCrop
                                                            ? 'bg-amber-500'
                                                            : pageHasColor
                                                                ? 'bg-rose-400'
                                                                : 'bg-slate-300'
                                                )}>
                                                    {pageValidated ? <Check className="h-3 w-3" /> :
                                                        pageHasCrop ? '~' :
                                                            pageHasColor ? <Palette className="h-3 w-3" /> :
                                                                '-'}
                                                </div>
                                            </div>

                                            {/* Color mini thumbnail */}
                                            {pageHasColor && (
                                                <div className="w-full aspect-[2/3] bg-rose-50 rounded overflow-hidden relative mt-1 border border-rose-200">
                                                    <Image
                                                        src={getProxiedImageUrl(page.url_image_color)}
                                                        alt={`Color ${page.numero_page}`}
                                                        fill
                                                        sizes="150px"
                                                        className="object-cover"
                                                        loading="lazy"
                                                    />
                                                </div>
                                            )}

                                            <div className="text-[11px] font-medium text-slate-700 mt-1">
                                                Page {page.numero_page}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </ScrollArea>
                </div>

                {/* ── Column 3: Alignment editor ── */}
                <div className="flex-1 bg-slate-50/50 flex flex-col min-h-0">
                    <div className="p-3 font-semibold text-slate-700 border-b bg-white flex justify-between items-center text-sm shrink-0">
                        <span>Editeur d'alignement</span>
                        {selectedPage && (
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    disabled={!canGoPrev}
                                    onClick={() => navigatePage(-1)}
                                    title="Page précédente (←)"
                                >
                                    <ArrowLeft className="h-3.5 w-3.5" />
                                </Button>
                                <span className="text-xs font-normal text-slate-500">
                                    Page {selectedPage.numero_page}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    disabled={!canGoNext}
                                    onClick={() => navigatePage(1)}
                                    title="Page suivante (→)"
                                >
                                    <ArrowRight className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        )}
                    </div>

                    <ScrollArea className="flex-1 h-full">
                        <div className="p-4">
                            {!selectedPage ? (
                                <div className="flex flex-col items-center justify-center text-slate-400 p-8 text-center min-h-[400px]">
                                    <Palette className="h-12 w-12 mb-3 opacity-20" />
                                    <p className="text-sm font-medium">Sélectionnez une page pour gérer sa variante couleur</p>
                                    <p className="text-xs text-slate-300 mt-1">Utilisez les flèches ← → pour naviguer</p>
                                </div>
                            ) : (
                                <div className="space-y-5">
                                    {/* Status bar */}
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <Badge variant="outline" className={cn(
                                            "text-xs px-2 py-1",
                                            hasColor
                                                ? isValidated
                                                    ? "border-emerald-400 text-emerald-700 bg-emerald-50"
                                                    : hasCropData
                                                        ? "border-amber-400 text-amber-700 bg-amber-50"
                                                        : "border-rose-400 text-rose-700 bg-rose-50"
                                                : "border-slate-300 text-slate-500"
                                        )}>
                                            {hasColor
                                                ? isValidated
                                                    ? "Validé"
                                                    : hasCropData
                                                        ? "Aligné (non validé)"
                                                        : "Couleur (non aligné)"
                                                : "Pas de couleur"
                                            }
                                        </Badge>

                                        {selectedPage.color_source_pages && (
                                            <span className="text-[10px] text-slate-400">
                                                Source: {selectedPage.color_source_pages.map(s => s.filename).join(' + ')}
                                            </span>
                                        )}
                                    </div>

                                    {/* ── No color: upload prompt ── */}
                                    {!hasColor && (
                                        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-8 text-center space-y-4">
                                            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto">
                                                <Palette className="h-8 w-8 text-slate-300" />
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-slate-700">Aucune variante couleur</p>
                                                <p className="text-xs text-slate-400 mt-1">Uploadez une image couleur pour cette page</p>
                                            </div>
                                            <div className="flex justify-center">
                                                <label className="cursor-pointer">
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        className="hidden"
                                                        onChange={handleUploadColor}
                                                        disabled={uploadingColor}
                                                    />
                                                    <div className="flex items-center gap-2 px-4 py-2 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors text-sm font-medium">
                                                        {uploadingColor ? (
                                                            <Loader2 className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <Upload className="h-4 w-4" />
                                                        )}
                                                        Uploader une image couleur
                                                    </div>
                                                </label>
                                            </div>
                                            {uploadingColor && (
                                                <Progress value={uploadProgress} className="h-1.5 max-w-xs mx-auto" />
                                            )}
                                        </div>
                                    )}

                                    {/* ── Has color: preview + controls ── */}
                                    {hasColor && (
                                        <>
                                            {/* Preview mode selector */}
                                            <div className="flex items-center gap-3">
                                                <Label className="text-xs text-slate-500">Aperçu:</Label>
                                                <div className="flex gap-1">
                                                    {[
                                                        { value: 'side', label: 'Côte à côte' },
                                                        { value: 'overlay', label: 'Superposition' },
                                                        { value: 'diff', label: 'Différence' },
                                                    ].map(mode => (
                                                        <Button
                                                            key={mode.value}
                                                            variant={previewMode === mode.value ? "default" : "outline"}
                                                            size="sm"
                                                            className="h-7 text-xs"
                                                            onClick={() => setPreviewMode(mode.value)}
                                                        >
                                                            {mode.label}
                                                        </Button>
                                                    ))}
                                                </div>
                                                {previewMode === 'overlay' && (
                                                    <div className="flex items-center gap-2 ml-2">
                                                        <Label className="text-xs text-slate-400">Opacité:</Label>
                                                        <input
                                                            type="range"
                                                            min="0"
                                                            max="1"
                                                            step="0.05"
                                                            value={overlayOpacity}
                                                            onChange={e => setOverlayOpacity(parseFloat(e.target.value))}
                                                            className="w-24 h-1.5 accent-blue-500"
                                                        />
                                                        <span className="text-xs text-slate-400 w-8">{Math.round(overlayOpacity * 100)}%</span>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Image preview area */}
                                            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                                                {previewMode === 'side' && (
                                                    <div className="grid grid-cols-2 gap-0">
                                                        <div className="relative aspect-[2/3] border-r border-slate-100">
                                                            <div className="absolute top-2 left-2 z-10 px-2 py-0.5 bg-slate-900/70 text-white text-[10px] font-bold rounded">
                                                                N&B
                                                            </div>
                                                            <Image
                                                                src={getProxiedImageUrl(selectedPage.url_image)}
                                                                alt="B&W"
                                                                fill
                                                                sizes="40vw"
                                                                className="object-contain bg-slate-50"
                                                            />
                                                        </div>
                                                        <div className="relative aspect-[2/3]">
                                                            <div className="absolute top-2 left-2 z-10 px-2 py-0.5 bg-rose-500/70 text-white text-[10px] font-bold rounded">
                                                                Couleur
                                                            </div>
                                                            <Image
                                                                src={getProxiedImageUrl(selectedPage.url_image_color)}
                                                                alt="Color"
                                                                fill
                                                                sizes="40vw"
                                                                className="object-contain bg-rose-50"
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                                {previewMode === 'overlay' && (
                                                    <div className="relative aspect-[2/3]">
                                                        <Image
                                                            src={getProxiedImageUrl(selectedPage.url_image)}
                                                            alt="B&W"
                                                            fill
                                                            sizes="60vw"
                                                            className="object-contain"
                                                        />
                                                        <div
                                                            className="absolute inset-0"
                                                            style={{ opacity: overlayOpacity }}
                                                        >
                                                            <Image
                                                                src={getProxiedImageUrl(selectedPage.url_image_color)}
                                                                alt="Color overlay"
                                                                fill
                                                                sizes="60vw"
                                                                className="object-contain"
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                                {previewMode === 'diff' && (
                                                    <div className="relative aspect-[2/3]">
                                                        <Image
                                                            src={getProxiedImageUrl(selectedPage.url_image)}
                                                            alt="B&W"
                                                            fill
                                                            sizes="60vw"
                                                            className="object-contain"
                                                        />
                                                        <div
                                                            className="absolute inset-0 mix-blend-difference"
                                                        >
                                                            <Image
                                                                src={getProxiedImageUrl(selectedPage.url_image_color)}
                                                                alt="Color diff"
                                                                fill
                                                                sizes="60vw"
                                                                className="object-contain"
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Manual offset controls */}
                                            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
                                                <div className="flex items-center gap-2">
                                                    <Move className="h-4 w-4 text-slate-500" />
                                                    <span className="text-sm font-medium text-slate-700">Décalage manuel</span>
                                                    <span className="text-[10px] text-slate-400 ml-auto">
                                                        {hasCropData ? `Affine: ${selectedPage.color_crop_data.affine.map(v => v.toFixed(2)).join(', ')}` : 'Pas de transform'}
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-2 gap-4">
                                                    <div className="space-y-1">
                                                        <Label className="text-xs text-slate-500">Offset X (px)</Label>
                                                        <Input
                                                            type="number"
                                                            value={manualOffsetX}
                                                            onChange={e => setManualOffsetX(parseInt(e.target.value) || 0)}
                                                            className="h-8 text-sm"
                                                        />
                                                    </div>
                                                    <div className="space-y-1">
                                                        <Label className="text-xs text-slate-500">Offset Y (px)</Label>
                                                        <Input
                                                            type="number"
                                                            value={manualOffsetY}
                                                            onChange={e => setManualOffsetY(parseInt(e.target.value) || 0)}
                                                            className="h-8 text-sm"
                                                        />
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Action buttons */}
                                            <div className="flex items-center gap-2 flex-wrap">
                                                {/* Align button */}
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={runAlignment}
                                                    disabled={isAligning}
                                                    className="text-xs"
                                                >
                                                    {isAligning ? (
                                                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                    ) : (
                                                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                                    )}
                                                    {isAligning ? (alignProgress || 'Alignement...') : 'Aligner (ORB+RANSAC)'}
                                                </Button>

                                                {/* Validate button */}
                                                {!isValidated ? (
                                                    <Button
                                                        size="sm"
                                                        className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                                                        onClick={() => handleValidate(true)}
                                                    >
                                                        <Check className="h-3.5 w-3.5 mr-1.5" />
                                                        Valider l'alignement
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="text-xs border-emerald-300 text-emerald-700"
                                                        onClick={() => handleValidate(false)}
                                                    >
                                                        <X className="h-3.5 w-3.5 mr-1.5" />
                                                        Retirer validation
                                                    </Button>
                                                )}

                                                {/* Replace color */}
                                                <label className="cursor-pointer">
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        className="hidden"
                                                        onChange={handleUploadColor}
                                                        disabled={uploadingColor}
                                                    />
                                                    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md hover:bg-slate-50 transition-colors cursor-pointer">
                                                        {uploadingColor ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        ) : (
                                                            <Upload className="h-3.5 w-3.5" />
                                                        )}
                                                        Remplacer
                                                    </div>
                                                </label>

                                                {/* Delete color */}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                                                    onClick={handleDeleteColor}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                                    Supprimer couleur
                                                </Button>
                                            </div>

                                            {uploadingColor && (
                                                <Progress value={uploadProgress} className="h-1.5" />
                                            )}

                                            {/* Crop data info */}
                                            {hasCropData && (
                                                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 space-y-1">
                                                    <div className="flex items-center gap-1.5">
                                                        <Info className="h-3.5 w-3.5 text-slate-400" />
                                                        <span className="text-xs font-medium text-slate-600">Données d'alignement</span>
                                                    </div>
                                                    <div className="text-[10px] text-slate-400 font-mono space-y-0.5">
                                                        <p>Affine: [{selectedPage.color_crop_data.affine.map(v => v.toFixed(4)).join(', ')}]</p>
                                                        <p>Offset: ({selectedPage.color_crop_data.manual_offset_x || 0}, {selectedPage.color_crop_data.manual_offset_y || 0})</p>
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>
            </div>
        </div>
    );
}
