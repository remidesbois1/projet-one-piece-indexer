"use client";

import React, { useState, useEffect } from 'react';
import { getAdminHierarchy, getAdminBubblesForPage, getBubbleHistory } from '@/lib/api';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    ChevronRight,
    BookOpen,
    FileText,
    MessageCircle,
    Layers,
    Calendar,
    Search,
    Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function AdminDataPage() {
    const [hierarchy, setHierarchy] = useState([]);
    const [loading, setLoading] = useState(true);

    // Selection state
    const [selectedTome, setSelectedTome] = useState(null);
    const [selectedChapter, setSelectedChapter] = useState(null);
    const [selectedPage, setSelectedPage] = useState(null);
    const [bubbles, setBubbles] = useState([]);

    const [loadingBubbles, setLoadingBubbles] = useState(false);


    // History Modal State
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
        <div className="h-[calc(100vh-4rem)] flex flex-col">
            <div className="border-b p-4 bg-white flex justify-between items-center">
                <h1 className="text-xl font-bold flex items-center gap-2">
                    <Layers className="h-5 w-5 text-blue-600" />
                    Explorateur de Données
                </h1>
                <div className="text-sm text-slate-500">
                    Navigation rapide : Volumes &gt; Chapitres &gt; Pages &gt; Bulles
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden min-h-0">
                {/* COL 1: Volumes & Chapters */}
                <div className="w-1/4 min-w-[250px] border-r bg-slate-50 flex flex-col min-h-0">
                    <div className="p-3 font-semibold text-slate-700 border-b bg-slate-100 shrink-0">
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
                                                    ? "bg-blue-100 text-blue-700 font-medium"
                                                    : "hover:bg-slate-200 text-slate-700"
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <BookOpen className="h-4 w-4" />
                                                <span>Tome {tome.numero}</span>
                                            </div>
                                            {selectedTome?.id === tome.id && <ChevronRight className="h-4 w-4" />}
                                        </button>

                                        {selectedTome?.id === tome.id && (
                                            <div className="ml-4 pl-2 border-l-2 border-slate-200 space-y-1 mt-1">
                                                {tome.chapitres.map(chap => (
                                                    <button
                                                        key={chap.id}
                                                        onClick={(e) => handleChapterClick(chap, e)}
                                                        className={cn(
                                                            "w-full flex items-center justify-between p-2 rounded-md text-sm transition-colors text-left",
                                                            selectedChapter?.id === chap.id
                                                                ? "bg-white shadow-sm text-blue-600 ring-1 ring-blue-100"
                                                                : "hover:bg-white/50 text-slate-600"
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

                {/* COL 2: Pages List */}
                <div className="w-1/4 min-w-[250px] border-r bg-white flex flex-col min-h-0">
                    <div className="p-3 font-semibold text-slate-700 border-b bg-slate-50 flex justify-between shrink-0">
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
                                                ? "border-blue-500 bg-blue-50/30 ring-1 ring-blue-500"
                                                : "border-slate-200 hover:border-blue-300 hover:shadow-sm"
                                        )}
                                    >
                                        <div className="w-full aspect-[2/3] bg-slate-100 mb-2 rounded overflow-hidden relative">
                                            {page.url_image ? (
                                                <img src={page.url_image} alt="" className="w-full h-full object-cover" loading="lazy" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <ImageOff className="h-6 w-6 text-slate-300" />
                                                </div>
                                            )}
                                            {/* Status Badge Over Image */}
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
                                        <div className="text-xs font-medium text-slate-700">Page {page.numero_page}</div>
                                        <div className="text-[10px] text-slate-400">{page.bulles[0]?.count || 0} bulles</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>

                {/* COL 3: Bubbles Detail */}
                <div className="flex-1 bg-slate-50/50 flex flex-col min-h-0">
                    <div className="p-3 font-semibold text-slate-700 border-b bg-white flex justify-between shrink-0">
                        <span>Détail Bubbles</span>
                        {selectedPage && <span className="text-xs font-normal text-slate-500 self-center">Page {selectedPage.numero_page}</span>}
                    </div>
                    {/* Use relative container + absolute ScrollArea to guarantee height constraint */}
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
                                        {/* Header Stats */}
                                        <div className="grid grid-cols-4 gap-4 mb-6">
                                            <div className="bg-white p-3 rounded border shadow-sm flex flex-col items-center">
                                                <span className="text-xs text-slate-500 uppercase">Total</span>
                                                <span className="text-xl font-bold">{bubbles.length}</span>
                                            </div>
                                            <div className="bg-white p-3 rounded border shadow-sm flex flex-col items-center border-green-100 bg-green-50/20">
                                                <span className="text-xs text-green-600 uppercase">Validées</span>
                                                <span className="text-xl font-bold text-green-700">{bubbles.filter(b => b.statut === 'Validé').length}</span>
                                            </div>
                                            <div className="bg-white p-3 rounded border shadow-sm flex flex-col items-center border-blue-100 bg-blue-50/20">
                                                <span className="text-xs text-blue-600 uppercase">Proposées</span>
                                                <span className="text-xl font-bold text-blue-700">{bubbles.filter(b => b.statut === 'Proposé').length}</span>
                                            </div>
                                            <div className="bg-white p-3 rounded border shadow-sm flex flex-col items-center border-red-100 bg-red-50/20">
                                                <span className="text-xs text-red-600 uppercase">Rejetées</span>
                                                <span className="text-xl font-bold text-red-700">{bubbles.filter(b => b.statut === 'Rejeté').length}</span>
                                            </div>
                                        </div>

                                        {/* Table-like list */}
                                        <div className="bg-white border rounded-md shadow-sm overflow-hidden">
                                            <div className="grid grid-cols-12 bg-slate-100 p-2 text-xs font-semibold text-slate-600 border-b">
                                                <div className="col-span-1 text-center">#</div>
                                                <div className="col-span-1">Statut</div>
                                                <div className="col-span-6">Texte</div>
                                                <div className="col-span-2">Info Bulle (x,y,w,h)</div>
                                                <div className="col-span-2 text-right">Actions</div>
                                            </div>
                                            {bubbles.map((bubble, idx) => (
                                                <div
                                                    key={bubble.id}
                                                    className="grid grid-cols-12 p-3 text-sm border-b last:border-0 hover:bg-slate-50 items-center cursor-pointer transition-colors hover:bg-blue-50/50"
                                                    onClick={() => setHistoryBubble(bubble)}
                                                >
                                                    <div className="col-span-1 text-center font-mono text-slate-400">{bubble.order || idx + 1}</div>
                                                    <div className="col-span-1">
                                                        <Badge variant="outline" className={cn(
                                                            "text-[10px] px-1",
                                                            bubble.statut === 'Validé' ? "border-green-500 text-green-600 bg-green-50" :
                                                                bubble.statut === 'Rejeté' ? "border-red-500 text-red-600 bg-red-50" :
                                                                    "border-blue-500 text-blue-600 bg-blue-50"
                                                        )}>
                                                            {bubble.statut}
                                                        </Badge>
                                                    </div>
                                                    <div className="col-span-6 pr-4 font-medium text-slate-800 line-clamp-2" title={bubble.texte_propose}>
                                                        {bubble.texte_propose || <span className="text-slate-300 italic">Vide</span>}
                                                    </div>
                                                    <div className="col-span-2 text-xs font-mono text-slate-500">
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
                                            <div key={entry.id} className="relative pl-6 pb-6 border-l-2 border-slate-200 last:border-0 last:pb-0">
                                                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-slate-300 border-4 border-white shadow-sm ring-1 ring-slate-100"></div>

                                                <div className="flex justify-between items-start mb-1">
                                                    <div className="flex flex-col">
                                                        <span className="font-bold text-slate-700 capitalize text-sm">
                                                            {entry.action === 'create' ? 'Création' :
                                                                entry.action === 'validate' ? 'Validation' :
                                                                    entry.action === 'reject' ? 'Rejet' :
                                                                        entry.action === 'update_text' ? 'Modification Texte' :
                                                                            entry.action}
                                                        </span>
                                                        <span className="text-xs text-slate-500">{formatDate(entry.created_at)}</span>
                                                    </div>
                                                    <Badge variant="outline" className="text-[10px] text-slate-500 bg-slate-50">
                                                        {entry.user_id}
                                                    </Badge>
                                                </div>

                                                <div className="text-sm mt-2 text-slate-600">
                                                    {/* User display logic fallback if email is null */}
                                                    <div className="flex items-center gap-1 text-xs text-slate-400 mb-2">
                                                        <UserIconDisplay email={entry.user?.email} id={entry.user_id} />
                                                    </div>

                                                    {entry.comment && (
                                                        <div className="bg-orange-50 border border-orange-100 text-orange-800 p-2 rounded text-xs italic mb-2">
                                                            "{entry.comment}"
                                                        </div>
                                                    )}

                                                    {entry.action === 'update_text' && entry.old_data?.texte_propose && (
                                                        <div className="grid grid-cols-2 gap-2 mt-2">
                                                            <div className="bg-red-50 p-2 rounded border border-red-100">
                                                                <div className="text-[10px] font-bold text-red-400 uppercase mb-1">Avant</div>
                                                                <div className="text-xs text-slate-600 line-through">{entry.old_data.texte_propose}</div>
                                                            </div>
                                                            <div className="bg-green-50 p-2 rounded border border-green-100">
                                                                <div className="text-[10px] font-bold text-green-400 uppercase mb-1">Après</div>
                                                                <div className="text-xs text-slate-800">{entry.new_data.texte_propose}</div>
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
    // If email exists, show it. Otherwise show ID.
    return (
        <>
            <span className="w-4 h-4 bg-slate-200 rounded-full flex items-center justify-center text-[10px] font-bold text-slate-500">
                U
            </span>
            <span>
                {email ? email : <span className="font-mono">{id}</span>}
            </span>
        </>
    )
}

function ImageOff({ className }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="2" y1="2" x2="22" y2="22"></line><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"></path><line x1="13.5" y1="13.5" x2="6" y2="21"></line><line x1="18" y1="12" x2="21" y2="15"></line><path d="M3.59 13.59A1.99 1.99 0 0 0 3 15v4a2 2 0 0 0 2 2h4c.55 0 1.05-.22 1.41-.59"></path><path d="M21 5v-.9a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"></path></svg>
    )
}
