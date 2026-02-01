"use client";

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useRouter } from 'next/navigation';
import { getTomes, getChapitres, getPages } from '@/lib/api';
import { getProxiedImageUrl } from '@/lib/utils';

import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

import { ChevronRight, ArrowLeft, BookOpen, Library, CheckCircle2, PenLine } from "lucide-react";

export default function HomePage() {
    const { session, isGuest } = useAuth();
    const { loading: profileLoading } = useUserProfile();
    const router = useRouter();

    const [tomes, setTomes] = useState([]);
    const [chapters, setChapters] = useState([]);
    const [pages, setPages] = useState([]);

    const [isSheetOpen, setIsSheetOpen] = useState(false);
    const [selectedTome, setSelectedTome] = useState(null);
    const [selectedChapter, setSelectedChapter] = useState(null);
    const [isLoadingData, setIsLoadingData] = useState(false);

    useEffect(() => {
        if (session?.access_token || isGuest) {
            getTomes().then(res => setTomes(res.data)).catch(console.error);
        }
    }, [session, isGuest]);

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
            <header className="flex items-center justify-between mb-10 pb-4 border-b border-slate-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-900 rounded-lg text-white">
                        <Library size={20} />
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                        Poneglyph Archives
                    </h1>
                    <Badge variant="outline" className="ml-2 font-mono text-xs border-slate-200 text-slate-500">
                        {tomes.length} VOLUMES
                    </Badge>
                </div>
            </header>

            {/* GRID DES TOMES */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 sm:gap-8">
                {tomes.map((tome) => (
                    <Card
                        key={tome.id}
                        onClick={() => openTome(tome)}
                        className="group cursor-pointer border-0 shadow-sm ring-1 ring-slate-200 bg-white overflow-hidden transition-all duration-300 hover:shadow-xl hover:ring-slate-300 hover:-translate-y-2 rounded-xl"
                    >
                        <div className="aspect-[2/3] w-full overflow-hidden bg-slate-100 relative">
                            {tome.cover_url ? (
                                <>
                                    <img
                                        src={getProxiedImageUrl(tome.cover_url)}
                                        crossOrigin="anonymous"
                                        alt={`Tome ${tome.numero}`}
                                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110 will-change-transform"
                                        loading="lazy"
                                    />
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors duration-300" />
                                </>
                            ) : (
                                <div className="flex flex-col h-full items-center justify-center text-slate-300 bg-slate-50 gap-2">
                                    <BookOpen size={40} strokeWidth={1.5} />
                                    <span className="text-xs font-medium uppercase tracking-widest opacity-50">No Cover</span>
                                </div>
                            )}
                        </div>

                        <div className="p-4 bg-white border-t border-slate-50 relative z-10">
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                                        Volume
                                    </span>
                                    <span className="text-lg font-bold text-slate-800 font-mono group-hover:text-primary transition-colors">
                                        {tome.numero}
                                    </span>
                                </div>
                                <div className="h-8 w-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-300 group-hover:bg-slate-900 group-hover:text-white transition-all duration-300">
                                    <ChevronRight size={14} />
                                </div>
                            </div>
                        </div>
                    </Card>
                ))}

                {tomes.length === 0 && [1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} className="aspect-[2/3] rounded-xl bg-slate-100 animate-pulse" />
                ))}
            </div>

            <Sheet open={isSheetOpen} onOpenChange={handleSheetChange}>
                <SheetContent className="w-full sm:max-w-md p-0 flex flex-col bg-white border-l border-slate-100 shadow-2xl">

                    <div className="px-6 py-6 border-b border-slate-100 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
                        <SheetHeader className="text-left space-y-0">
                            {selectedChapter ? (
                                <div className="space-y-2">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 -ml-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                                        onClick={() => setSelectedChapter(null)}
                                    >
                                        <ArrowLeft className="mr-1 h-4 w-4" />
                                        Retour au Tome {selectedTome?.numero}
                                    </Button>
                                    <div>
                                        <SheetTitle className="text-2xl font-bold text-slate-900">Chapitre {selectedChapter.numero}</SheetTitle>
                                        <SheetDescription className="text-slate-500">
                                            {selectedChapter.titre || "Sélectionnez une page à éditer"}
                                        </SheetDescription>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <SheetTitle className="text-3xl font-bold text-slate-900">Tome {selectedTome?.numero}</SheetTitle>
                                    <SheetDescription>
                                        Choisissez un chapitre pour commencer l'indexation.
                                    </SheetDescription>
                                </div>
                            )}
                        </SheetHeader>
                    </div>

                    <ScrollArea className="flex-1 bg-slate-50/50">
                        <div className="p-6">

                            {!selectedChapter && (
                                isLoadingData ? (
                                    <div className="space-y-3">
                                        {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl bg-white" />)}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {chapters.map((chap) => {
                                            const styles = getChapterStyle(chap.global_status);

                                            return (
                                                <div
                                                    key={chap.id}
                                                    onClick={() => openChapter(chap)}
                                                    className={`
                            flex items-center justify-between p-4 rounded-xl border cursor-pointer group transition-all duration-200
                            ${styles.container}
                          `}
                                                >
                                                    <div className="flex items-center gap-4">
                                                        <div className={`
                                h-10 w-10 rounded-lg flex items-center justify-center font-mono font-bold transition-colors
                                ${styles.iconBg}
                            `}>
                                                            {styles.icon ? styles.icon : chap.numero}
                                                        </div>

                                                        <div className="flex flex-col">
                                                            <span className={`text-sm font-medium transition-colors ${styles.text}`}>
                                                                {styles.icon ? `Chapitre ${chap.numero}` : (chap.titre || "Chapitre sans titre")}
                                                            </span>
                                                            <span className={`text-xs ${styles.subtext}`}>
                                                                {styles.icon ? (chap.titre || "Complet") : "Cliquez pour voir les pages"}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <ChevronRight className={`h-5 w-5 text-slate-300 transition-transform group-hover:translate-x-1 ${styles.subtext}`} />
                                                </div>
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
                                    <div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-2 mb-6 p-4 bg-white rounded-xl border border-slate-100 shadow-sm">
                                            <div className="w-full text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">
                                                Légende
                                            </div>
                                            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-slate-200"></div><span className="text-xs text-slate-600">Vide</span></div>
                                            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-orange-400"></div><span className="text-xs text-slate-600">En cours</span></div>
                                            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-yellow-400"></div><span className="text-xs text-slate-600">En attente de validation</span></div>
                                            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-green-400"></div><span className="text-xs text-slate-600">Terminé</span></div>
                                        </div>

                                        <div className="flex flex-wrap gap-2">
                                            {pages.map((page) => (
                                                <div
                                                    key={page.id}
                                                    onClick={() => router.push(`/annotate/${page.id}`)}
                                                    className={`
                            h-12 w-12 flex items-center justify-center rounded-lg border-2 text-sm font-bold cursor-pointer transition-all duration-200 shadow-sm
                            ${getPageStatusColor(page.statut)}
                            scale-100 hover:scale-110 active:scale-95
                            `}
                                                    title={`Page ${page.numero_page} - ${page.statut}`}
                                                >
                                                    {page.numero_page}
                                                </div>
                                            ))}
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
