"use client";

import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useManga } from '@/context/MangaContext';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useRouter } from 'next/navigation';
import { deleteBubblesForChapter, deleteBubblesForPage, getTomes, getChapitres, getPages } from '@/lib/api';
import { getCoverThumbnailUrl, getPageDisplayStatus } from '@/lib/utils';
import CoverThumbnailImage from '@/components/CoverThumbnailImage';
import { toast } from 'sonner';

import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

import { ChevronRight, ChevronLeft, ArrowLeft, BookOpen, CheckCircle2, PenLine, Loader2, Trash2, Search, ArrowUpDown } from "lucide-react";

export default function DashboardPage() {
    const { profile, loading: profileLoading } = useUserProfile();
    const { session } = useAuth();
    const router = useRouter();
    const { mangaSlug, currentManga } = useManga();

    const [tomes, setTomes] = useState([]);
    const [chapters, setChapters] = useState([]);
    const [pages, setPages] = useState([]);

    const [isSheetOpen, setIsSheetOpen] = useState(false);
    const [selectedTome, setSelectedTome] = useState(null);
    const [selectedChapter, setSelectedChapter] = useState(null);
    const [isLoadingData, setIsLoadingData] = useState(false);
    const [deletingTarget, setDeletingTarget] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [sortDirection, setSortDirection] = useState('asc');
    const [currentPage, setCurrentPage] = useState(1);
    const drawerRef = useRef(null);
    const drawerDragStartYRef = useRef(null);
    const drawerDragYRef = useRef(0);
    const drawerDragFrameRef = useRef(null);
    const isAdmin = profile?.role === 'Admin';
    const volumesPerPage = 5;

    useEffect(() => {
        getTomes().then(res => setTomes(res.data)).catch(console.error);
    }, []);

    const displayedTomes = useMemo(() => {
        const normalizedSearch = searchTerm.trim().toLowerCase();
        return [...tomes]
            .filter((tome) => {
                if (!normalizedSearch) return true;
                return [
                    tome.numero,
                    tome.titre,
                    tome.title,
                    tome.nom,
                ].filter(Boolean).some(value => String(value).toLowerCase().includes(normalizedSearch));
            })
            .sort((a, b) => {
                const aNumber = Number(a.numero) || 0;
                const bNumber = Number(b.numero) || 0;
                return sortDirection === 'asc' ? aNumber - bNumber : bNumber - aNumber;
            });
    }, [searchTerm, sortDirection, tomes]);

    const totalPages = Math.max(1, Math.ceil(displayedTomes.length / volumesPerPage));
    const paginatedTomes = displayedTomes.slice((currentPage - 1) * volumesPerPage, currentPage * volumesPerPage);

    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, sortDirection]);

    useEffect(() => {
        if (isSheetOpen) {
            const drawer = drawerRef.current;
            if (drawer) {
                drawer.style.transform = '';
                drawer.style.transition = '';
                drawer.style.willChange = '';
            }
            drawerDragYRef.current = 0;
            drawerDragStartYRef.current = null;
        }
    }, [isSheetOpen]);

    useEffect(() => {
        return () => {
            if (drawerDragFrameRef.current) {
                cancelAnimationFrame(drawerDragFrameRef.current);
            }
        };
    }, []);

    const selectedTomeTitle = selectedTome?.titre || selectedTome?.title || selectedTome?.nom || "A l'aube d'une grande aventure";

    const applyDrawerDrag = (dragY) => {
        drawerDragYRef.current = dragY;

        if (drawerDragFrameRef.current) return;

        drawerDragFrameRef.current = requestAnimationFrame(() => {
            drawerDragFrameRef.current = null;
            const drawer = drawerRef.current;
            if (!drawer) return;

            drawer.style.transition = 'none';
            drawer.style.transform = `translate3d(0, ${drawerDragYRef.current}px, 0)`;
        });
    };

    const handleDrawerPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        drawerDragStartYRef.current = event.clientY;
        drawerDragYRef.current = 0;
        const drawer = drawerRef.current;
        if (drawer) {
            drawer.style.transition = 'none';
            drawer.style.willChange = 'transform';
        }
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handleDrawerPointerMove = (event) => {
        if (drawerDragStartYRef.current === null) return;

        const rawDragY = event.clientY - drawerDragStartYRef.current;
        const dragY = rawDragY <= 0
            ? Math.max(-14, rawDragY * 0.14)
            : rawDragY > 420
                ? 420 + (rawDragY - 420) * 0.28
                : rawDragY;

        applyDrawerDrag(dragY);
    };

    const handleDrawerPointerUp = (event) => {
        if (drawerDragStartYRef.current === null) return;

        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }

        if (drawerDragFrameRef.current) {
            cancelAnimationFrame(drawerDragFrameRef.current);
            drawerDragFrameRef.current = null;
        }

        const drawer = drawerRef.current;
        const shouldClose = drawerDragYRef.current > 130;

        drawerDragStartYRef.current = null;
        drawerDragYRef.current = 0;

        if (shouldClose) {
            setIsSheetOpen(false);
            return;
        }

        if (drawer) {
            drawer.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)';
            drawer.style.transform = 'translate3d(0, 0, 0)';
            window.setTimeout(() => {
                if (drawerDragStartYRef.current !== null || !drawerRef.current) return;
                drawer.style.transform = '';
                drawer.style.transition = '';
                drawer.style.willChange = '';
            }, 190);
        }
    };

    const openTome = async (tome) => {
        setSelectedTome(tome);
        setSelectedChapter(null);
        setPages([]);
        setIsSheetOpen(true);
        setIsLoadingData(true);

        try {
            const res = await getChapitres(tome.id);
            setChapters(res.data);
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoadingData(false);
        }
    };

    const openChapter = async (chapter) => {
        setSelectedChapter(chapter);
        setIsLoadingData(true);
        try {
            const res = await getPages(chapter.id);
            setPages(res.data);
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoadingData(false);
        }
    };

    const handleSheetChange = (open) => {
        setIsSheetOpen(open);
        if (!open) {
            setTimeout(() => {
                setSelectedTome(null);
                setSelectedChapter(null);
            }, 300);
        }
    };

    const handleDeletePageBubbles = async (page, event) => {
        event.stopPropagation();
        if (!isAdmin || deletingTarget) return;
        const confirmed = window.confirm(`Supprimer toutes les bulles de la page ${page.numero_page} ?\n\nCette action est irreversible.`);
        if (!confirmed) return;

        const target = `page-${page.id}`;
        setDeletingTarget(target);
        try {
            const { data } = await deleteBubblesForPage(page.id);
            setPages(prev => prev.map(item => item.id === page.id ? { ...item, statut: 'not_started' } : item));
            toast.success(`${data?.deleted || 0} bulle(s) supprimÃ©e(s) sur la page ${page.numero_page}.`);
        } catch (error) {
            toast.error(error?.response?.data?.error || "Suppression des bulles de la page impossible.");
        } finally {
            setDeletingTarget(null);
        }
    };

    const handleDeleteChapterBubbles = async () => {
        if (!isAdmin || !selectedChapter || deletingTarget) return;
        const confirmed = window.confirm(`Supprimer toutes les bulles du chapitre ${selectedChapter.numero} ?\n\nToutes les pages du chapitre repasseront en non commencÃ©es. Cette action est irreversible.`);
        if (!confirmed) return;

        const target = `chapter-${selectedChapter.id}`;
        setDeletingTarget(target);
        try {
            const { data } = await deleteBubblesForChapter(selectedChapter.id);
            setPages(prev => prev.map(page => ({ ...page, statut: 'not_started' })));
            setChapters(prev => prev.map(chapter => chapter.id === selectedChapter.id ? { ...chapter, global_status: 'empty' } : chapter));
            setSelectedChapter(prev => prev ? { ...prev, global_status: 'empty' } : prev);
            toast.success(`${data?.deleted || 0} bulle(s) supprimÃ©e(s) sur le chapitre ${selectedChapter.numero}.`);
        } catch (error) {
            toast.error(error?.response?.data?.error || "Suppression des bulles du chapitre impossible.");
        } finally {
            setDeletingTarget(null);
        }
    };

    const getPageStatusColor = (status) => {
        switch (status) {
            case 'in_progress':
                return "bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100 hover:border-orange-300";
            case 'pending_review':
                return "bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100 hover:border-yellow-300";
            case 'completed':
                return "bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:border-green-300";
            case 'rejected':
                return "bg-red-50 text-red-700 border-red-200 hover:bg-red-100 hover:border-red-300";
            default:
                return "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100";
        }
    };

    const getChapterStyle = (status) => {
        switch (status) {
            case 'completed':
                return {
                    container: "bg-green-50/50 border-green-200 hover:border-green-300 hover:bg-green-50",
                    iconBg: "bg-green-100 text-green-700",
                    text: "text-green-900",
                    subtext: "text-green-600",
                    icon: <CheckCircle2 className="h-5 w-5 text-green-600" />
                };
            case 'in_progress':
                return {
                    container: "bg-orange-50/50 border-orange-200 hover:border-orange-300 hover:bg-orange-50",
                    iconBg: "bg-orange-100 text-orange-700",
                    text: "text-orange-900",
                    subtext: "text-orange-600",
                    icon: <PenLine className="h-5 w-5 text-orange-600" />
                };
            default:
                return {
                    container: "bg-white border-slate-200 hover:border-slate-300 hover:shadow-md",
                    iconBg: "bg-slate-100 text-slate-600",
                    text: "text-slate-900",
                    subtext: "text-slate-500",
                    icon: null
                };
        }
    };

    if (profileLoading) return null;

    return (
        <div className="w-full">
            <header className="mb-9 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-3">
                            <h1 className="poneglyph-title text-4xl font-extrabold sm:text-5xl">
                                Bibliothèque {currentManga?.titre || 'Poneglyph'}
                            </h1>
                            <Badge variant="outline" className="poneglyph-chip h-9 rounded-full px-4 text-xs font-black uppercase tracking-wide">
                                {tomes.length} volumes
                            </Badge>
                        </div>
                    </div>
                </div>

                <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
                    <label className="relative block min-w-0 flex-1 lg:w-[370px]">
                        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8dbbff]" />
                        <input
                            value={searchTerm}
                            onChange={(event) => setSearchTerm(event.target.value)}
                            placeholder="Rechercher un volume..."
                            className="poneglyph-input h-14 w-full rounded-lg pl-12 pr-4 text-sm font-semibold outline-none transition"
                        />
                    </label>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
                        className="h-14 gap-2 rounded-lg border-white/14 bg-white/8 px-5 text-[#bdd6ff] shadow-sm hover:bg-white/14 hover:text-white"
                    >
                        <ArrowUpDown size={18} />
                        Trier {sortDirection === 'asc' ? '↑' : '↓'}
                    </Button>
                </div>
            </header>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {paginatedTomes.map((tome) => {
                    const tomeTitle = tome.titre || tome.title || tome.nom || 'Ã‰dition Originale';

                    return (
                        <article
                            key={tome.id}
                            onClick={() => openTome(tome)}
                            className="poneglyph-panel poneglyph-card-hover group cursor-pointer overflow-hidden rounded-xl"
                        >
                            <div className="relative aspect-[2/3] w-full overflow-hidden bg-[#071625]">
                                {tome.cover_url ? (
                                    <CoverThumbnailImage
                                        src={getCoverThumbnailUrl(tome.cover_url, 512)}
                                        crossOrigin="anonymous"
                                        alt={`Tome ${tome.numero}`}
                                        fill
                                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 20vw"
                                        className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.03] group-hover:brightness-[1.03]"
                                        unoptimized
                                        loading="lazy"
                                    />
                                ) : (
                                    <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-500">
                                        <BookOpen size={44} strokeWidth={1.5} />
                                        <span className="text-xs font-black uppercase tracking-widest">No Cover</span>
                                    </div>
                                )}
                            </div>

                            <div className="relative min-h-36 border-t border-white/10 bg-[#071625]/82 p-5">
                                <span className="text-xs font-black uppercase tracking-wide text-slate-400">
                                    Volume
                                </span>
                                <div className="mt-1 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="font-serif text-3xl font-black leading-tight text-white">
                                            {tome.numero}
                                        </div>
                                        <div className="mt-2 truncate text-sm font-black text-slate-100">
                                            {tomeTitle}
                                        </div>
                                    </div>
                                    <div className="mt-8 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#8dbbff]/26 bg-white/8 text-[#8dbbff] shadow-sm transition group-hover:border-[#3d86ff] group-hover:bg-[#3d86ff] group-hover:text-white">
                                        <ChevronRight size={17} />
                                    </div>
                                </div>
                            </div>
                        </article>
                    );
                })}

                {tomes.length === 0 && [1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="aspect-[2/3] animate-pulse rounded-xl border border-white/10 bg-white/8" />
                ))}
            </div>

            {tomes.length > 0 && (
                <div className="mt-9 flex items-center justify-center gap-4">
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={currentPage === 1}
                        onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                        className="h-11 w-11 rounded-full border-white/14 bg-white/8 text-[#8dbbff] shadow-sm hover:bg-white/14 disabled:opacity-45"
                    >
                        <ChevronLeft size={20} />
                    </Button>
                    <div className="flex h-14 min-w-14 items-center justify-center rounded-full bg-[#3d86ff] px-5 text-xl font-black text-white shadow-[0_15px_30px_rgba(61,134,255,0.28)]">
                        {currentPage}
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={currentPage === totalPages}
                        onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                        className="h-11 w-11 rounded-full border-white/14 bg-white/8 text-[#8dbbff] shadow-sm hover:bg-white/14 disabled:opacity-45"
                    >
                        <ChevronRight size={20} />
                    </Button>
                </div>
            )}

            <Sheet open={isSheetOpen} onOpenChange={handleSheetChange}>
                <SheetContent
                    ref={drawerRef}
                    side="bottom"
                    className="mx-auto h-[min(82vh,760px)] w-[calc(100%-1.5rem)] max-w-[1460px] overflow-hidden rounded-t-[28px] border border-white/14 bg-[#06111e]/96 p-0 text-slate-100 shadow-[0_-22px_80px_rgba(0,0,0,0.48)] backdrop-blur-xl sm:w-[calc(100%-4rem)]"
                >

                    <div
                        className="flex h-9 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
                        onPointerDown={handleDrawerPointerDown}
                        onPointerMove={handleDrawerPointerMove}
                        onPointerUp={handleDrawerPointerUp}
                        onPointerCancel={handleDrawerPointerUp}
                    >
                        <span className="h-1.5 w-16 rounded-full bg-white/24" />
                    </div>

                    <div className="relative h-[220px] overflow-hidden border-b border-white/10 bg-[#081827]/88 px-5 pb-6 pt-1 sm:h-[250px] sm:px-8 lg:px-10">
                        <SheetHeader className="relative z-10 h-full justify-center p-0 text-left">
                            {selectedChapter ? (
                                <div className="space-y-3">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="-ml-2 h-9 rounded-full px-2 text-slate-300 hover:bg-white/8 hover:text-white"
                                        onClick={() => setSelectedChapter(null)}
                                    >
                                        <ArrowLeft className="mr-1 h-4 w-4" />
                                        Retour au Tome {selectedTome?.numero}
                                    </Button>
                                     <div>
                                         <SheetTitle className="font-serif text-3xl font-black text-white sm:text-4xl">Chapitre {selectedChapter.numero}</SheetTitle>
                                         <SheetDescription className="mt-2 max-w-2xl text-base font-medium text-slate-300">
                                             {selectedChapter.titre || "SÃ©lectionnez une page Ã  Ã©diter"}
                                         </SheetDescription>
                                     </div>
                                     {isAdmin && (
                                         <Button
                                             variant="outline"
                                             size="sm"
                                             onClick={handleDeleteChapterBubbles}
                                             disabled={Boolean(deletingTarget)}
                                             className="h-9 rounded-full border-red-200 bg-red-50 text-xs font-black text-red-700 hover:bg-red-100 hover:text-red-800"
                                         >
                                             {deletingTarget === `chapter-${selectedChapter.id}` ? (
                                                 <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                             ) : (
                                                 <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                             )}
                                             Vider le chapitre
                                         </Button>
                                     )}
                                 </div>
                             ) : (
                                <div className="grid gap-5 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center lg:grid-cols-[140px_minmax(0,1fr)]">
                                    <div className="relative hidden aspect-[2/3] overflow-hidden rounded-lg border border-white/14 bg-[#071625] shadow-[0_16px_34px_rgba(0,0,0,0.32)] sm:block">
                                        {selectedTome?.cover_url ? (
                                            <CoverThumbnailImage
                                                src={getCoverThumbnailUrl(selectedTome.cover_url, 512)}
                                                alt={`Tome ${selectedTome.numero}`}
                                                fill
                                                sizes="140px"
                                                className="h-full w-full object-cover"
                                                unoptimized
                                            />
                                        ) : (
                                            <div className="flex h-full items-center justify-center text-[#7b8aa9]">
                                                <BookOpen size={34} strokeWidth={1.5} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="relative z-10 max-w-3xl">
                                        <SheetTitle className="font-serif text-4xl font-black leading-tight text-white sm:text-5xl">Tome {selectedTome?.numero}</SheetTitle>
                                        <SheetDescription className="mt-3 text-base font-semibold text-slate-300 sm:text-lg">
                                            {selectedTomeTitle}
                                        </SheetDescription>
                                        <div className="mt-6 flex flex-wrap gap-3">
                                            <div className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/12 bg-white/8 px-4 text-sm font-black text-slate-300 shadow-sm">
                                                <BookOpen size={17} className="text-[#8dbbff]" />
                                                {chapters.length} chapitres
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </SheetHeader>
                    </div>

                    <ScrollArea className="min-h-0 flex-1 bg-[#030a13]/82">
                        <div className="p-5 sm:p-8 lg:p-10">

                            {!selectedChapter && (
                                isLoadingData ? (
                                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                        {[1, 2, 3, 4, 5, 6, 7, 8].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl bg-white/10" />)}
                                    </div>
                                ) : (
                                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                        {chapters.map((chap) => {
                                            const styles = getChapterStyle(chap.global_status);

                                            return (
                                                <button
                                                    type="button"
                                                    key={chap.id}
                                                    onClick={() => openChapter(chap)}
                                                    className="group flex min-h-20 items-center justify-between gap-4 rounded-xl border border-white/12 bg-white/[0.065] p-4 text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-[#8dbbff]/38 hover:bg-white/[0.09]"
                                                >
                                                    <span className="flex min-w-0 items-center gap-4">
                                                        <span className={`
                                h-10 w-10 rounded-lg flex items-center justify-center font-mono font-bold transition-colors
                                ${styles.iconBg}
                            `}>
                                                            {styles.icon ? styles.icon : chap.numero}
                                                        </span>

                                                        <span className="min-w-0">
                                                            <span className="block truncate text-sm font-black text-white">
                                                                Chapitre {chap.numero}
                                                            </span>
                                                            <span className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-slate-300">
                                                                {chap.titre || "Chapitre sans titre"}
                                                            </span>
                                                        </span>
                                                    </span>
                                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/8 text-[#8dbbff] shadow-sm transition group-hover:border-[#3d86ff] group-hover:bg-[#3d86ff] group-hover:text-white">
                                                        <ChevronRight size={17} />
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )
                            )}

                            {selectedChapter && (
                                isLoadingData ? (
                                    <div className="grid grid-cols-5 gap-3">
                                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => <Skeleton key={i} className="aspect-square rounded-lg" />)}
                                    </div>
                                ) : (
                                    <div className="space-y-5">
                                        <div className="flex flex-col gap-4 rounded-xl border border-white/12 bg-white/[0.065] p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                                            <div>
                                                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                                                    Pages du chapitre
                                                </div>
                                                <div className="mt-1 text-sm font-semibold text-white">
                                                    {pages.length} pages disponibles
                                                </div>
                                            </div>
                                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                                                <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-slate-300"></div><span className="text-xs font-semibold text-slate-300">Vide</span></div>
                                                <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-orange-400"></div><span className="text-xs font-semibold text-slate-300">En cours</span></div>
                                                <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-yellow-400"></div><span className="text-xs font-semibold text-slate-300">À valider</span></div>
                                                <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-green-400"></div><span className="text-xs font-semibold text-slate-300">Terminé</span></div>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                                             {pages.map((page) => {
                                                 const displayStatus = getPageDisplayStatus(page.statut, !session);
                                                 const statusLabel = {
                                                     in_progress: 'En cours',
                                                     pending_review: 'À valider',
                                                     completed: 'Terminé',
                                                     rejected: 'Rejete',
                                                     not_started: 'Vide',
                                                 }[displayStatus] || 'Vide';

                                                 return (
                                                     <div
                                                         key={page.id}
                                                         onClick={() => router.push(`/${mangaSlug}/annotate/${page.id}`)}
                                                         className={`
                                group/page relative flex min-h-24 cursor-pointer flex-col justify-between rounded-xl border p-3.5 text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_34px_rgba(32,76,121,0.13)]
                                ${getPageStatusColor(displayStatus)}
                                `}
                                                         title={`Page ${page.numero_page} - ${displayStatus}`}
                                                     >
                                                         <div className="flex items-start justify-between gap-2">
                                                             <div>
                                                                 <div className="text-[10px] font-black uppercase tracking-wider opacity-70">
                                                                     Page
                                                                 </div>
                                                                 <div className="mt-1 font-serif text-2xl font-black leading-none">
                                                                     {page.numero_page}
                                                                 </div>
                                                             </div>
                                                             <ChevronRight className="mt-1 h-5 w-5 opacity-55 transition group-hover/page:translate-x-0.5 group-hover/page:opacity-100" />
                                                         </div>
                                                         <div className="mt-4 text-xs font-black">
                                                             {statusLabel}
                                                         </div>
                                                         {isAdmin && (
                                                             <button
                                                                 type="button"
                                                                 onClick={(event) => handleDeletePageBubbles(page, event)}
                                                                 disabled={Boolean(deletingTarget)}
                                                                 className="absolute -right-1.5 -top-1.5 hidden h-7 w-7 items-center justify-center rounded-full border border-red-200 bg-white text-red-600 shadow-sm hover:bg-red-50 disabled:opacity-50 group-hover/page:flex"
                                                                 title={`Supprimer les bulles de la page ${page.numero_page}`}
                                                             >
                                                                 {deletingTarget === `page-${page.id}` ? (
                                                                     <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                 ) : (
                                                                     <Trash2 className="h-3.5 w-3.5" />
                                                                 )}
                                                             </button>
                                                         )}
                                                     </div>
                                                 );
                                             })}
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    </ScrollArea>

                </SheetContent>
            </Sheet>
        </div>
    );
}
