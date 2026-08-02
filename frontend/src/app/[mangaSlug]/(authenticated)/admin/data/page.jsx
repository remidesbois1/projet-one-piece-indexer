"use client";

import React, { useState, useEffect } from 'react';
import { useManga } from '@/context/MangaContext';
import { useAuth } from '@/context/AuthContext';
import { getAdminHierarchy, getAdminBubblesForPage, getBubbleHistory } from '@/lib/api';
import { fetchOriginalPageThumbnail } from '@/lib/pageImageClient';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
    ChevronRight,
    BookOpen,
    FileText,
    Layers,
    Loader2,
    ImageOff
} from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export default function AdminDataPage() {
    const { currentManga } = useManga();
    const { session } = useAuth();
    const pageTitle = currentManga ? `Explorateur : ${currentManga.titre}` : "Explorateur de Données";
    const [hierarchy, setHierarchy] = useState([]);
    const [loading, setLoading] = useState(true);


    const [selectedTome, setSelectedTome] = useState(null);
    const [selectedChapter, setSelectedChapter] = useState(null);
    const [selectedPage, setSelectedPage] = useState(null);
    const [bubbles, setBubbles] = useState([]);
    const [originalImageState, setOriginalImageState] = useState({ chapterKey: null, urls: {}, errors: {} });

    const [loadingBubbles, setLoadingBubbles] = useState(false);

    useEffect(() => {
        let active = true;
        const objectUrls = [];
        const accessToken = session?.access_token;

        if (!selectedChapter || !accessToken) return undefined;

        const chapterKey = selectedChapter.id ?? selectedChapter.numero;

        selectedChapter.pages.forEach((page) => {
            fetchOriginalPageThumbnail(page.id, accessToken, { width: 320 })
                .then((blob) => {
                    if (!active) return;
                    const objectUrl = URL.createObjectURL(blob);
                    objectUrls.push(objectUrl);
                    setOriginalImageState((current) => {
                        const base = current.chapterKey === chapterKey
                            ? current
                            : { chapterKey, urls: {}, errors: {} };
                        return { ...base, urls: { ...base.urls, [page.id]: objectUrl } };
                    });
                })
                .catch(() => {
                    if (!active) return;
                    setOriginalImageState((current) => {
                        const base = current.chapterKey === chapterKey
                            ? current
                            : { chapterKey, urls: {}, errors: {} };
                        return { ...base, errors: { ...base.errors, [page.id]: true } };
                    });
                });
        });

        return () => {
            active = false;
            objectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
        };
    }, [selectedChapter, session?.access_token]);

    const chapterImageState = originalImageState.chapterKey === (selectedChapter?.id ?? selectedChapter?.numero)
        ? originalImageState
        : { urls: {}, errors: {} };



    const [historyBubble, setHistoryBubble] = useState(null);
    const [history, setHistory] = useState([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    useEffect(() => {
        loadHierarchy();
    }, []);

    const loadHierarchy = async () => {
        setLoading(true);
        try {
            const res = await getAdminHierarchy();
            setHierarchy(res.data);
        } catch (error) {
            console.error("Error loading hierarchy", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (selectedPage) {
            loadBubbles(selectedPage.id);
        } else {
            setBubbles([]);
        }
    }, [selectedPage]);

    const loadBubbles = async (pageId) => {
        setLoadingBubbles(true);
        try {
            const res = await getAdminBubblesForPage(pageId);
            setBubbles(res.data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoadingBubbles(false);
        }
    };

    useEffect(() => {
        if (historyBubble) {
            setLoadingHistory(true);
            getBubbleHistory(historyBubble.id)
                .then(res => setHistory(res.data))
                .catch(err => console.error("Error history", err))
                .finally(() => setLoadingHistory(false));
        } else {
            setHistory([]);
        }
    }, [historyBubble]);

    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleString('fr-FR', {
            day: '2-digit', month: '2-digit', year: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    };

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

    return (
        <div className="container max-w-7xl mx-auto h-full overflow-y-auto py-10 px-4 sm:px-6">
            {pageTitle && <title>{pageTitle}</title>}
            <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-center">
                <h1 className="poneglyph-title flex items-center gap-2 text-xl font-bold">
                    <Layers className="h-5 w-5 text-[#8dbbff]" />
                    Explorateur de Données
                </h1>
                <div className="text-sm text-slate-400">
                    Navigation rapide : Volumes &gt; Chapitres &gt; Pages &gt; Bulles
                </div>
            </div>

            <div className="poneglyph-panel flex min-h-[720px] flex-1 overflow-hidden rounded-xl">

                <div className="flex min-h-0 w-1/4 min-w-[250px] flex-col border-r border-white/10 bg-white/[0.045]">
                    <div className="shrink-0 border-b border-white/10 bg-white/[0.055] p-3 font-semibold text-slate-200">
                        Volumes
                    </div>
                    <ScrollArea className="flex-1 h-full">
                        {loading ? (
                            <div className="p-4 flex justify-center"><Loader2 className="animate-spin h-6 w-6 text-slate-400" /></div>
                        ) : (
                            <div className="p-2 space-y-1">
                                {hierarchy.map(tome => (
                                    <div key={tome.id} className="space-y-1">
                                        <button
                                            onClick={() => handleTomeClick(tome)}
                                            className={cn(
                                                "w-full flex items-center justify-between p-2 rounded-md text-sm transition-colors",
                                                selectedTome?.id === tome.id
                                                    ? "bg-[#3d86ff]/16 text-white font-medium"
                                                    : "hover:bg-white/8 text-slate-300"
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <BookOpen className="h-4 w-4" />
                                                <span>Tome {tome.numero}</span>
                                            </div>
                                            {selectedTome?.id === tome.id && <ChevronRight className="h-4 w-4" />}
                                        </button>

                                        {selectedTome?.id === tome.id && (
                                            <div className="ml-4 pl-2 border-l-2 border-white/12 space-y-1 mt-1">
                                                {tome.chapitres.map(chap => (
                                                    <button
                                                        key={chap.id}
                                                        onClick={(e) => handleChapterClick(chap, e)}
                                                        className={cn(
                                                            "w-full flex items-center justify-between p-2 rounded-md text-sm transition-colors text-left",
                                                            selectedChapter?.id === chap.id
                                                                ? "bg-white/10 text-[#8dbbff] ring-1 ring-[#8dbbff]/30"
                                                                : "hover:bg-white/8 text-slate-300"
                                                        )}
                                                    >
                                                        <span>Chapitre {chap.numero}</span>
                                                        <Badge variant="secondary" className="text-[10px] h-5">
                                                            {chap.pages.length} p
                                                        </Badge>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>


                <div className="flex min-h-0 w-1/4 min-w-[250px] flex-col border-r border-white/10 bg-white/[0.03]">
                    <div className="flex shrink-0 justify-between border-b border-white/10 bg-white/[0.045] p-3 font-semibold text-slate-200">
                        <span>Pages</span>
                        {selectedChapter && <span className="text-xs font-normal text-slate-500 self-center">Chap. {selectedChapter.numero}</span>}
                    </div>
                    <ScrollArea className="flex-1 h-full">
                        {!selectedChapter ? (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
                                <BookOpen className="h-10 w-10 mb-2 opacity-20" />
                                <p>Sélectionnez un chapitre</p>
                            </div>
                        ) : (
                            <div className="p-2 grid grid-cols-2 gap-2">
                                {selectedChapter.pages.map(page => (
                                    <button
                                        key={page.id}
                                        onClick={() => setSelectedPage(page)}
                                        className={cn(
                                            "flex flex-col items-center p-2 rounded border transition-all relative overflow-hidden group",
                                            selectedPage?.id === page.id
                                                ? "border-[#3d86ff] bg-[#3d86ff]/12 ring-1 ring-[#8dbbff]/40"
                                                : "border-white/12 bg-white/[0.055] hover:border-[#8dbbff]/38"
                                        )}
                                    >
                                        <div className="w-full aspect-[2/3] bg-[#040d18] mb-2 rounded overflow-hidden relative">
                                            {chapterImageState.urls[page.id] ? (
                                                <Image
                                                    src={chapterImageState.urls[page.id]}
                                                    alt={`Page ${page.numero_page}`}
                                                    fill
                                                    sizes="(max-width: 768px) 50vw, 20vw"
                                                    className="object-cover"
                                                    unoptimized
                                                    loading="lazy"
                                                />
                                            ) : chapterImageState.errors[page.id] ? (
                                                <div className="flex h-full w-full items-center justify-center">
                                                    <ImageOff className="h-6 w-6 text-red-300" />
                                                </div>
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center">
                                                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                                                </div>
                                            )}

                                            <div className="absolute top-1 right-1">
                                                <Badge className={cn(
                                                    "text-[9px] px-1 h-4",
                                                    page.statut === 'finished' ? "bg-green-500" :
                                                        page.statut === 'in_progress' ? "bg-blue-500" : "bg-slate-500"
                                                )}>
                                                    {page.statut === 'finished' ? 'OK' : page.statut === 'in_progress' ? '...' : '-'}
                                                </Badge>
                                            </div>
                                        </div>
                                        <div className="text-xs font-medium text-slate-200">Page {page.numero_page}</div>
                                        <div className="text-[10px] text-slate-400">{page.bulles[0]?.count || 0} bulles</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>


                <div className="flex min-h-0 flex-1 flex-col bg-[#030a13]/28">
                    <div className="flex shrink-0 justify-between border-b border-white/10 bg-white/[0.045] p-3 font-semibold text-slate-200">
                        <span>Détail Bubbles</span>
                        {selectedPage && <span className="text-xs font-normal text-slate-500 self-center">Page {selectedPage.numero_page}</span>}
                    </div>

                    <div className="flex-1 relative">
                        <ScrollArea className="absolute inset-0 h-full w-full">
                            <div className="p-4">
                                {!selectedPage ? (
                                    <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center min-h-[300px]">
                                        <FileText className="h-10 w-10 mb-2 opacity-20" />
                                        <p>Sélectionnez une page pour voir les bulles</p>
                                    </div>
                                ) : loadingBubbles ? (
                                    <div className="flex justify-center p-8"><Loader2 className="animate-spin h-8 w-8 text-blue-500" /></div>
                                ) : bubbles.length === 0 ? (
                                    <div className="text-center text-slate-500 py-8">Aucune bulle sur cette page.</div>
                                ) : (
                                    <div className="space-y-4">

                                        <div className="grid grid-cols-4 gap-4 mb-6">
                                            <div className="bg-white/[0.055] border border-white/12 p-3 rounded flex flex-col items-center">
                                                <span className="text-xs text-slate-400 uppercase">Total</span>
                                                <span className="text-xl font-bold text-white">{bubbles.length}</span>
                                            </div>
                                            <div className="bg-white/[0.055] border border-white/12 p-3 rounded flex flex-col items-center">
                                                <span className="text-xs text-emerald-400 uppercase">Validées</span>
                                                <span className="text-xl font-bold text-white">{bubbles.filter(b => b.statut === 'Validé').length}</span>
                                            </div>
                                            <div className="bg-white/[0.055] border border-white/12 p-3 rounded flex flex-col items-center">
                                                <span className="text-xs text-[#8dbbff] uppercase">Proposées</span>
                                                <span className="text-xl font-bold text-white">{bubbles.filter(b => b.statut === 'Proposé').length}</span>
                                            </div>
                                            <div className="bg-white/[0.055] border border-white/12 p-3 rounded flex flex-col items-center">
                                                <span className="text-xs text-red-400 uppercase">Rejetées</span>
                                                <span className="text-xl font-bold text-white">{bubbles.filter(b => b.statut === 'Rejeté').length}</span>
                                            </div>
                                        </div>


                                        <div className="bg-[#040d18]/60 border border-white/12 rounded-md overflow-hidden">
                                            <div className="grid grid-cols-12 bg-white/[0.06] p-2 text-xs font-semibold text-slate-400 border-b border-white/10">
                                                <div className="col-span-1 text-center">#</div>
                                                <div className="col-span-1">Statut</div>
                                                <div className="col-span-6">Texte</div>
                                                <div className="col-span-2">Info Bulle (x,y,w,h)</div>
                                                <div className="col-span-2 text-right">Actions</div>
                                            </div>
                                            {bubbles.map((bubble, idx) => (
                                                <div
                                                    key={bubble.id}
                                                    className="grid grid-cols-12 p-3 text-sm border-b border-white/8 last:border-0 hover:bg-white/[0.05] items-center cursor-pointer transition-colors"
                                                    onClick={() => setHistoryBubble(bubble)}
                                                >
                                                    <div className="col-span-1 text-center font-mono text-slate-400">{bubble.order || idx + 1}</div>
                                                    <div className="col-span-1">
                                                        <Badge variant="outline" className={cn(
                                                            "text-[10px] px-1",
                                                            bubble.statut === 'Validé' ? "border-emerald-400/40 bg-emerald-500/12 text-emerald-300" :
                                                                bubble.statut === 'Rejeté' ? "border-red-400/40 bg-red-500/12 text-red-300" :
                                                                    "border-[#8dbbff]/40 bg-[#3d86ff]/12 text-[#bcd6ff]"
                                                        )}>
                                                            {bubble.statut}
                                                        </Badge>
                                                    </div>
                                                    <div className="col-span-6 pr-4 font-medium text-slate-200 line-clamp-2" title={bubble.texte_propose}>
                                                        {bubble.texte_propose || <span className="text-slate-500 italic">Vide</span>}
                                                    </div>
                                                    <div className="col-span-2 text-xs font-mono text-slate-400">
                                                        {bubble.x}, {bubble.y} <br />
                                                        {bubble.w} x {bubble.h}
                                                    </div>
                                                    <div className="col-span-2 text-right">
                                                        <span className="text-xs text-slate-400">ID: ...{String(bubble.id).slice(-4)}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </ScrollArea>
                    </div>
                </div>
            </div>

            <Dialog open={!!historyBubble} onOpenChange={(open) => !open && setHistoryBubble(null)}>
                <DialogContent className="max-w-2xl h-[80vh] flex flex-col p-0 gap-0 overflow-hidden">
                    <div className="p-6 pb-2 shrink-0">
                        <DialogHeader>
                            <DialogTitle>Historique de la bulle</DialogTitle>
                            <DialogDescription className="text-xs text-slate-400">
                                ID: {historyBubble?.id}
                            </DialogDescription>
                        </DialogHeader>
                    </div>

                    <div className="flex-1 min-h-0 relative">
                        <ScrollArea className="h-full w-full">
                            <div className="p-6 pt-2">
                                {loadingHistory ? (
                                    <div className="flex justify-center p-8"><Loader2 className="animate-spin h-8 w-8 text-slate-300" /></div>
                                ) : history.length === 0 ? (
                                    <div className="text-center text-slate-500 py-8">
                                        Aucun historique disponible pour cette bulle.
                                    </div>
                                ) : (
                                    <div className="space-y-6">
                                        {history.map((entry) => (
                                            <div key={entry.id} className="relative pl-6 pb-6 border-l-2 border-white/12 last:border-0 last:pb-0">
                                                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-[#8dbbff] border-4 border-[#071625] shadow-sm ring-1 ring-[#8dbbff]/40"></div>

                                                <div className="flex justify-between items-start mb-1">
                                                    <div className="flex flex-col">
                                                        <span className="font-bold text-slate-200 capitalize text-sm">
                                                            {entry.action === 'create' ? 'Création' :
                                                                entry.action === 'validate' ? 'Validation' :
                                                                    entry.action === 'reject' ? 'Rejet' :
                                                                        entry.action === 'update_text' ? 'Modification Texte' :
                                                                            entry.action}
                                                        </span>
                                                        <span className="text-xs text-slate-500">{formatDate(entry.created_at)}</span>
                                                    </div>
                                                    <Badge variant="outline" className="text-[10px] text-slate-400 bg-white/[0.06] border-white/12">
                                                        {entry.user_id}
                                                    </Badge>
                                                </div>

                                                <div className="text-sm mt-2 text-slate-300">

                                                    <div className="flex items-center gap-1 text-xs text-slate-400 mb-2">
                                                        <UserIconDisplay email={entry.user?.email} id={entry.user_id} />
                                                    </div>

                                                    {entry.comment && (
                                                        <div className="bg-amber-500/12 border border-amber-400/30 text-amber-100 p-2 rounded text-xs italic mb-2">
                                                            &quot;{entry.comment}&quot;
                                                        </div>
                                                    )}

                                                    {entry.action === 'update_text' && entry.old_data?.texte_propose && (
                                                        <div className="grid grid-cols-2 gap-2 mt-2">
                                                            <div className="bg-red-500/12 p-2 rounded border border-red-400/30">
                                                                <div className="text-[10px] font-bold text-red-300 uppercase mb-1">Avant</div>
                                                                <div className="text-xs text-slate-300 line-through">{entry.old_data.texte_propose}</div>
                                                            </div>
                                                            <div className="bg-emerald-500/12 p-2 rounded border border-emerald-400/30">
                                                                <div className="text-[10px] font-bold text-emerald-300 uppercase mb-1">Après</div>
                                                                <div className="text-xs text-slate-100">{entry.new_data.texte_propose}</div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </ScrollArea>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function UserIconDisplay({ email, id }) {

    return (
        <>
            <span className="w-4 h-4 bg-white/10 rounded-full flex items-center justify-center text-[10px] font-bold text-slate-300">
                U
            </span>
            <span>
                {email ? email : <span className="font-mono">{id}</span>}
            </span>
        </>
    )
}


