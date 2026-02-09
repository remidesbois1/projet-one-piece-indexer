"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useManga } from '@/context/MangaContext';
import { getPageById, getBubblesForPage, approvePage, rejectPage, rejectBubble } from '@/lib/api';
import { getProxiedImageUrl } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import ValidationForm from '@/components/ValidationForm';
import ModerationCommentModal from '@/components/ModerationCommentModal';

// Shadcn Components
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

// Icons
import { Check, X, ArrowLeft, Pencil } from "lucide-react";

export default function PageReview() {
    const params = useParams();
    const pageId = params?.pageId;
    const router = useRouter();
    const { session, isGuest } = useAuth(); // Assuming isGuest is available in context
    const { mangaSlug } = useManga();

    const [page, setPage] = useState(null);
    const [bubbles, setBubbles] = useState([]);
    const [loading, setLoading] = useState(true);

    const [editingBubble, setEditingBubble] = useState(null);

    const [imageDimensions, setImageDimensions] = useState(null);
    const imageContainerRef = useRef(null);
    const imageRef = useRef(null);

    const [hoveredBubble, setHoveredBubble] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    const fetchPageData = useCallback(async () => {
        if (!pageId || (!session?.access_token && !isGuest)) return;

        try {
            const [pageRes, bubblesRes] = await Promise.all([
                getPageById(pageId),
                getBubblesForPage(pageId)
            ]);
            setPage(pageRes.data);
            const sortedBubbles = bubblesRes.data.sort((a, b) => a.order - b.order);
            setBubbles(sortedBubbles);
        } catch (err) {
            console.error("Erreur chargement données:", err);
            // alert("Impossible de charger la page.");
        } finally {
            setLoading(false);
        }
    }, [pageId, session, isGuest]);

    useEffect(() => {
        setLoading(true);
        fetchPageData();
    }, [fetchPageData]);

    const handleApprove = async () => {
        if (window.confirm("Confirmer l'approbation de cette page ?")) {
            try {
                await approvePage(pageId);
                router.push(`/${mangaSlug}/moderation`);
            } catch (error) {
                alert("Erreur technique lors de l'approbation.");
                console.error(error);
            }
        }
    };

    const [showRejectModal, setShowRejectModal] = useState(false);

    const handleReject = async (comment) => {
        try {
            await rejectPage(pageId, comment);
            router.push(`/${mangaSlug}/moderation`);
        } catch (error) {
            alert("Erreur technique lors du rejet.");
            console.error(error);
        }
    };

    const [rejectingBubbleId, setRejectingBubbleId] = useState(null);

    const handleConfirmRejectBubble = async (comment) => {
        if (!rejectingBubbleId) return;
        try {
            await rejectBubble(rejectingBubbleId, comment);
            setRejectingBubbleId(null);
            fetchPageData();
        } catch (error) {
            alert("Erreur technique lors du rejet de la bulle.");
            console.error(error);
        }
    };

    const handleEditSuccess = () => {
        setEditingBubble(null);
        fetchPageData();
    };

    const handleMouseMove = (event) => {
        if (imageContainerRef.current) {
            const rect = imageContainerRef.current.getBoundingClientRect();
            setMousePos({
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            });
        }
    };

    if (loading) return (
        <div className="flex h-screen items-center justify-center bg-slate-50">
            <div className="text-slate-500 animate-pulse">Chargement de l'interface...</div>
        </div>
    );

    if (!page) return <div className="p-8 text-red-500">Page introuvable.</div>;

    const tomeNumber = page.chapitres?.tomes?.numero || '?';
    const chapterNumber = page.chapitres?.numero || '?';

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-slate-50">

            {/* HEADER DE L'OUTIL */}
            <header className="flex-none h-16 border-b border-slate-200 bg-white px-6 flex items-center justify-between z-20 shadow-sm">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="sm" onClick={() => router.push(`/${mangaSlug}/moderation`)}>
                        <ArrowLeft className="h-4 w-4 mr-2" /> Retour
                    </Button>
                    <div className="h-6 w-px bg-slate-200" />
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">Vérification Page {page.numero_page}</h2>
                        <div className="text-xs text-slate-500 font-mono">Tome {tomeNumber} • Chapitre {chapterNumber}</div>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <Button variant="destructive" onClick={() => setShowRejectModal(true)} className="gap-2">
                        <X className="h-4 w-4" /> Refuser
                    </Button>
                    <Button variant="default" onClick={handleApprove} className="bg-green-600 hover:bg-green-700 gap-2">
                        <Check className="h-4 w-4" /> Valider la Page
                    </Button>
                </div>
            </header>

            {/* CONTENU PRINCIPAL (Split View) */}
            <div className="flex flex-1 overflow-hidden">

                {/* ZONE IMAGE (Scrollable) */}
                <main className="flex-1 bg-slate-200/50 overflow-auto flex justify-center p-8 relative">
                    <div
                        ref={imageContainerRef}
                        className="relative bg-white shadow-xl rounded-sm max-w-none inline-block h-fit"
                        onMouseMove={handleMouseMove}
                        onMouseLeave={() => setHoveredBubble(null)}
                    >
                        <img
                            ref={imageRef}
                            src={getProxiedImageUrl(page.url_image)}
                            crossOrigin="anonymous"
                            alt={`Page ${page.numero_page}`}
                            className="max-w-full h-auto block rounded-sm pointer-events-none"
                            onLoad={(e) => setImageDimensions({
                                width: e.target.offsetWidth,
                                naturalWidth: e.target.naturalWidth
                            })}
                        />

                        {/* OVERLAYS DES BULLES */}
                        {imageDimensions && bubbles.map((bubble, index) => {
                            const scale = imageDimensions.width / imageDimensions.naturalWidth;
                            if (!scale || isNaN(scale)) return null;

                            return (
                                <div
                                    key={bubble.id}
                                    style={{
                                        left: `${bubble.x * scale}px`,
                                        top: `${bubble.y * scale}px`,
                                        width: `${bubble.w * scale}px`,
                                        height: `${bubble.h * scale}px`,
                                    }}
                                    className="absolute border-2 border-green-500 bg-green-500/10 hover:bg-green-500/20 transition-colors cursor-pointer z-10 group"
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                    onClick={() => setEditingBubble(bubble)}
                                >
                                    <div className="absolute -top-6 -left-[2px] bg-green-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm">
                                        #{index + 1}
                                    </div>
                                </div>
                            );
                        })}

                        {/* TOOLTIP FLOTTANT SUIVEUR */}
                        {hoveredBubble && (
                            <div
                                className="fixed z-50 pointer-events-none bg-slate-900/95 text-white p-3 rounded-lg shadow-xl border border-slate-700 backdrop-blur-sm max-w-[300px]"
                                style={{
                                    left: 0, top: 0,
                                    // On utilise fixed + translate pour suivre la souris sans lag
                                    transform: `translate(${mousePos.x + 20 + imageContainerRef.current?.getBoundingClientRect().left}px, ${mousePos.y + 20 + imageContainerRef.current?.getBoundingClientRect().top}px)`
                                }}
                            >
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                                    Bulle #{bubbles.findIndex(b => b.id === hoveredBubble.id) + 1}
                                </div>
                                <p className="text-sm font-medium leading-relaxed">
                                    {hoveredBubble.texte_propose}
                                </p>
                            </div>
                        )}
                    </div>
                </main>

                {/* SIDEBAR DROITE (Liste des textes) */}
                <aside className="w-[400px] bg-white border-l border-slate-200 flex flex-col h-full overflow-hidden z-10 shadow-lg">

                    {/* Header fixe de la sidebar */}
                    <div className="flex-none p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                        <h3 className="font-semibold text-slate-900">Textes détectés</h3>
                        <Badge variant="secondary" className="bg-slate-200 text-slate-700">
                            {bubbles.length}
                        </Badge>
                    </div>

                    {/* LISTE SCROLLABLE */}
                    <ScrollArea className="flex-1 w-full min-h-0">
                        <div className="p-0 pb-20"> {/* Padding bottom extra pour être sûr que le dernier élément est visible */}
                            {bubbles.map((bubble, index) => (
                                <div
                                    key={bubble.id}
                                    className="flex gap-4 p-4 border-b border-slate-50 hover:bg-slate-50 transition-colors group relative"
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                >
                                    <span className="font-mono text-slate-400 font-bold text-sm w-6 text-right pt-1 shrink-0">
                                        {index + 1}
                                    </span>
                                    <div className="flex-1 space-y-2">
                                        <p className="text-sm text-slate-800 leading-relaxed font-medium">
                                            {bubble.texte_propose}
                                        </p>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 text-xs text-blue-600 border-blue-100 bg-blue-50 hover:bg-blue-100 hover:text-blue-700 opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={() => setEditingBubble(bubble)}
                                        >
                                            <Pencil className="h-3 w-3 mr-1.5" /> Corriger
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </ScrollArea>
                </aside>
            </div>

            {/* MODAL D'ÉDITION */}
            <Dialog open={!!editingBubble} onOpenChange={(open) => !open && setEditingBubble(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Correction Rapide</DialogTitle>
                    </DialogHeader>
                    {editingBubble && (
                        <ValidationForm
                            annotationData={editingBubble}
                            onValidationSuccess={handleEditSuccess}
                            onCancel={() => setEditingBubble(null)}
                            onReject={(id) => {
                                setEditingBubble(null);
                                setRejectingBubbleId(id);
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>
            <ModerationCommentModal
                isOpen={showRejectModal}
                onClose={() => setShowRejectModal(false)}
                onSubmit={handleReject}
                title="Refuser cette page"
                description="L'utilisateur verra ce commentaire sur sa page 'Mes soumissions' pour comprendre les corrections nécessaires."
            />
            <ModerationCommentModal
                isOpen={!!rejectingBubbleId}
                onClose={() => setRejectingBubbleId(null)}
                onSubmit={handleConfirmRejectBubble}
                title="Refuser cette bulle"
                description="L'indexeur verra votre commentaire pour s'améliorer."
            />
        </div>
    );
}
