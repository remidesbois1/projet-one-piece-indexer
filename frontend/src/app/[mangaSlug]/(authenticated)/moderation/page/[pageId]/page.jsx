"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useManga } from '@/context/MangaContext';
import { getPageById, getBubblesForPage, approvePage, rejectPage, rejectBubble, savePageDescription, getMetadataSuggestions } from '@/lib/api';
import { generatePageDescription } from '@/lib/geminiClient';
import { getProxiedImageUrl, cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import ValidationForm from '@/components/ValidationForm';
import ModerationCommentModal from '@/components/ModerationCommentModal';
import ApiKeyForm from '@/components/ApiKeyForm';
import { toast } from "sonner";

// Shadcn Components
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Icons
import { Check, X, ArrowLeft, Pencil, FileText, Settings2, Save, Plus, Loader2, Sparkles, Code } from "lucide-react";

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

    // Metadata States
    const [showDescModal, setShowDescModal] = useState(false);
    const [isSavingDesc, setIsSavingDesc] = useState(false);
    const [isGeneratingAI, setIsGeneratingAI] = useState(false);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [formData, setFormData] = useState({ content: "", arc: "", characters: [] });
    const [suggestions, setSuggestions] = useState({ arcs: [], characters: [] });
    const [charInput, setCharInput] = useState("");
    const [tabMode, setTabMode] = useState("form");
    const [jsonInput, setJsonInput] = useState("");
    const [jsonError, setJsonError] = useState(null);

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

    // Metadata Handlers (from AnnotatePage)
    useEffect(() => {
        if (tabMode === 'form') {
            const jsonStructure = {
                content: formData.content,
                metadata: {
                    arc: formData.arc,
                    characters: formData.characters
                }
            };
            setJsonInput(JSON.stringify(jsonStructure, null, 4));
            setJsonError(null);
        }
    }, [formData, tabMode]);

    const handleJsonChange = (e) => {
        const val = e.target.value;
        setJsonInput(val);
        try {
            const parsed = JSON.parse(val);
            if (typeof parsed !== 'object' || parsed === null) throw new Error("Le JSON doit être un objet.");
            if (!parsed.metadata || typeof parsed.metadata !== 'object') throw new Error("L'objet doit contenir une clé 'metadata'.");

            setJsonError(null);
            setFormData({
                content: parsed.content || "",
                arc: parsed.metadata.arc || "",
                characters: Array.isArray(parsed.metadata.characters) ? parsed.metadata.characters : []
            });
        } catch (err) {
            setJsonError(err.message);
        }
    };

    useEffect(() => {
        if (page?.description) {
            let desc = page.description;
            if (typeof desc === 'string') {
                try { desc = JSON.parse(desc); } catch (e) { desc = { content: page.description, metadata: { arc: "", characters: [] } }; }
            }
            const newFormData = {
                content: desc.content || "",
                arc: desc.metadata?.arc || "",
                characters: desc.metadata?.characters || []
            };
            setFormData(newFormData);
            setJsonInput(JSON.stringify({ content: newFormData.content, metadata: { arc: newFormData.arc, characters: newFormData.characters } }, null, 4));
        }
    }, [page]);

    const fetchSuggestions = useCallback(async () => {
        if (!session?.access_token) return;
        try {
            const res = await getMetadataSuggestions();
            setSuggestions(res.data);
        } catch (err) { console.error("Erreur suggestions:", err); }
    }, [session]);

    useEffect(() => {
        if (showDescModal) fetchSuggestions();
    }, [showDescModal, fetchSuggestions]);

    const handleSaveApiKey = (key) => {
        localStorage.setItem('google_api_key', key);
        setShowApiKeyModal(false);
    };

    const handleSaveDescription = async () => {
        const payload = {
            content: formData.content,
            metadata: { arc: formData.arc, characters: formData.characters }
        };
        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            setShowApiKeyModal(true);
            return;
        }

        const previousPage = { ...page };
        setPage(prev => ({ ...prev, description: JSON.stringify(payload) }));
        setShowDescModal(false);
        setIsSavingDesc(true);

        try {
            await savePageDescription(pageId, payload);
            toast.success("Description enregistrée !");
        } catch (error) {
            setPage(previousPage);
            toast.error("Erreur lors de la sauvegarde.");
        } finally {
            setIsSavingDesc(false);
        }
    };

    const handleGenerateAI = async () => {
        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            setShowApiKeyModal(true);
            return;
        }
        setIsGeneratingAI(true);
        try {
            const res = await generatePageDescription(imageRef.current, storedKey);
            const aiData = res.data;
            setFormData({
                content: aiData.content || "",
                arc: aiData.metadata?.arc || "",
                characters: Array.isArray(aiData.metadata?.characters) ? aiData.metadata.characters : []
            });
            setJsonInput(JSON.stringify(aiData, null, 4));
            setJsonError(null);
        } catch (error) {
            console.error(error);
            toast.error("Erreur lors de la génération par IA.");
        } finally {
            setIsGeneratingAI(false);
        }
    };

    const addCharacter = (char) => {
        const cleanChar = char.trim();
        if (cleanChar && !formData.characters.includes(cleanChar)) {
            setFormData(prev => ({ ...prev, characters: [...prev.characters, cleanChar] }));
        }
        setCharInput("");
    };

    const removeCharacter = (char) => {
        setFormData(prev => ({ ...prev, characters: prev.characters.filter(c => c !== char) }));
    };

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
            <header className="flex-none h-auto min-h-16 border-b border-slate-200 bg-white px-4 sm:px-6 py-3 sm:py-0 flex flex-col lg:flex-row items-center justify-between z-20 shadow-sm gap-3 sm:gap-4 overflow-x-auto no-scrollbar">
                <div className="flex items-center justify-between w-full lg:w-auto gap-4 shrink-0">
                    <div className="flex items-center gap-2 sm:gap-4">
                        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => router.push(`/${mangaSlug}/moderation`)}>
                            <ArrowLeft className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">Retour</span>
                        </Button>
                        <div className="h-6 w-px bg-slate-200 hidden sm:block" />
                        <div className="flex flex-col sm:block">
                            <h2 className="text-sm sm:text-lg font-bold text-slate-900 truncate max-w-[150px] sm:max-w-none">
                                Vérification Page {page.numero_page}
                            </h2>
                            <div className="flex items-center gap-2 text-[10px] sm:text-xs text-slate-500 font-mono">
                                Tome {tomeNumber} • Chapitre {chapterNumber}
                                <Badge variant="outline" className="text-[9px] sm:text-[10px] px-1 py-0 h-3.5 sm:h-4 whitespace-nowrap bg-blue-50 text-blue-700 border-blue-100">MODÉRATION</Badge>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3 ml-auto py-2 lg:py-0">
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 gap-2 border-slate-200 text-slate-700 hover:bg-slate-50"
                            onClick={() => setShowDescModal(true)}
                        >
                            <FileText size={16} />
                            <span className="hidden xl:inline">Métadonnées</span>
                        </Button>

                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-slate-400 hover:text-slate-900"
                            onClick={() => setShowApiKeyModal(true)}
                        >
                            <Settings2 size={16} />
                        </Button>
                    </div>

                    <div className="h-6 w-px bg-slate-200 mx-1" />

                    <div className="flex items-center gap-2">
                        <Button variant="destructive" size="sm" onClick={() => setShowRejectModal(true)} className="h-9 gap-2">
                            <X className="h-4 w-4" /> Refuser
                        </Button>
                        <Button variant="default" size="sm" onClick={handleApprove} className="h-9 bg-green-600 hover:bg-green-700 gap-2 px-4 shadow-sm">
                            <Check className="h-4 w-4" /> Approuver la Page
                        </Button>
                    </div>
                </div>
            </header>

            {/* CONTENU PRINCIPAL (Split View) */}
            <div className="flex flex-1 overflow-hidden">

                {/* ZONE IMAGE (Scrollable) */}
                <main className="flex-1 bg-slate-200/50 overflow-auto flex justify-center p-4 sm:p-8 relative">
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
                <aside className="w-full lg:w-[400px] bg-white border-l border-slate-200 flex flex-col h-full overflow-hidden z-10 shadow-lg">

                    {/* Header fixe de la sidebar */}
                    <div className="flex-none p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                        <h3 className="font-semibold text-slate-900">Textes détectés</h3>
                        <Badge variant="secondary" className="bg-slate-200 text-slate-700">
                            {bubbles.length}
                        </Badge>
                    </div>

                    {/* LISTE SCROLLABLE */}
                    <ScrollArea className="flex-1 w-full min-h-0">
                        <div className="p-0 pb-20">
                            {/* Section Métadonnées Sémantiques (Aperçu) */}
                            {formData.content && (
                                <div className="p-4 bg-indigo-50/30 border-b border-indigo-100/50">
                                    <div className="flex items-center gap-2 mb-2">
                                        <FileText className="h-3.5 w-3.5 text-indigo-600" />
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-600">Métadonnées</span>
                                    </div>
                                    <p className="text-xs text-slate-700 line-clamp-3 italic mb-2">"{formData.content}"</p>
                                    <div className="flex flex-wrap gap-1">
                                        {formData.arc && <Badge variant="outline" className="text-[9px] px-1 py-0 bg-indigo-50 border-indigo-100 text-indigo-700">{formData.arc}</Badge>}
                                        {formData.characters.slice(0, 3).map(c => (
                                            <Badge key={c} variant="outline" className="text-[9px] px-1 py-0 bg-white border-slate-200 text-slate-600">{c}</Badge>
                                        ))}
                                        {formData.characters.length > 3 && <Badge variant="outline" className="text-[9px] px-1 py-0 bg-white border-slate-200 text-slate-400">+{formData.characters.length - 3}</Badge>}
                                    </div>
                                </div>
                            )}

                            {bubbles.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                                    <Pencil className="h-8 w-8 mb-2 opacity-20" />
                                    <p className="text-sm">Aucun texte à valider</p>
                                </div>
                            ) : (
                                bubbles.map((bubble, index) => (
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
                                ))
                            )}
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

            {/* MODAL DESCRIPTION SÉMANTIQUE */}
            <Dialog open={showDescModal} onOpenChange={setShowDescModal}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <div className="flex items-center justify-between pr-4">
                            <div>
                                <DialogTitle className="flex items-center gap-2">
                                    <FileText className="h-5 w-5 text-indigo-600" />
                                    Description Sémantique
                                </DialogTitle>
                                <DialogDescription>
                                    Définition des métadonnées pour le moteur de recherche.
                                </DialogDescription>
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleGenerateAI}
                                disabled={isGeneratingAI || isGuest}
                                className="gap-2 border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
                            >
                                {isGeneratingAI ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                Générer avec IA
                            </Button>
                        </div>
                    </DialogHeader>

                    <Tabs value={tabMode} onValueChange={setTabMode} className="w-full">
                        <TabsList className="grid w-full grid-cols-2 mb-4">
                            <TabsTrigger value="form">
                                <FileText className="h-4 w-4 mr-2" />
                                Formulaire
                            </TabsTrigger>
                            <TabsTrigger value="json">
                                <Code className="h-4 w-4 mr-2" />
                                JSON Raw
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="form" className="space-y-4 outline-none">
                            <div className="flex flex-col gap-3">
                                <Label htmlFor="scene-content" className="text-sm font-semibold text-slate-700">
                                    Contenu Sémantique
                                </Label>
                                <Textarea
                                    id="scene-content"
                                    value={formData.content}
                                    onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                                    className="min-h-[120px] resize-none border-slate-200 focus:ring-indigo-500"
                                    placeholder="Description de l'action, des lieux..."
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="flex flex-col gap-3">
                                    <Label className="text-sm font-semibold text-slate-700">Arc Narratif</Label>
                                    <div className="relative">
                                        <input
                                            list="arc-suggestions-mod"
                                            value={formData.arc}
                                            onChange={(e) => setFormData(prev => ({ ...prev, arc: e.target.value }))}
                                            className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:ring-indigo-500 focus:outline-none focus:ring-2"
                                            placeholder="Ex: Water 7"
                                        />
                                        <datalist id="arc-suggestions-mod">
                                            {suggestions.arcs.map(arc => <option key={arc} value={arc} />)}
                                        </datalist>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-3">
                                    <Label className="text-sm font-semibold text-slate-700">Personnages</Label>
                                    <div className="flex flex-col gap-2">
                                        <div className="flex gap-2">
                                            <input
                                                list="char-suggestions-mod"
                                                value={charInput}
                                                onChange={(e) => setCharInput(e.target.value)}
                                                onKeyDown={(e) => e.key === 'Enter' && addCharacter(charInput)}
                                                className="flex h-10 flex-1 rounded-md border border-slate-200 px-3 text-sm focus:ring-indigo-500 focus:outline-none focus:ring-2"
                                                placeholder="Ajouter..."
                                            />
                                            <datalist id="char-suggestions-mod">
                                                {suggestions.characters.map(c => <option key={c} value={c} />)}
                                            </datalist>
                                            <Button size="icon" variant="secondary" onClick={() => addCharacter(charInput)}>
                                                <Plus className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        <div className="flex flex-wrap gap-2 min-h-[40px] p-2 bg-slate-50 rounded border border-dashed border-slate-200">
                                            {formData.characters.map(char => (
                                                <Badge key={char} variant="secondary" className="gap-1 bg-white hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer" onClick={() => removeCharacter(char)}>
                                                    {char} <X className="h-3 w-3" />
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        <TabsContent value="json" className="outline-none">
                            <div className="relative">
                                <Textarea
                                    value={jsonInput}
                                    onChange={handleJsonChange}
                                    className={cn(
                                        "font-mono text-xs min-h-[350px] bg-slate-900 text-slate-50 resize-none",
                                        jsonError ? "border-red-500 focus:ring-red-500" : "border-slate-800 focus:ring-slate-700"
                                    )}
                                    spellCheck={false}
                                />
                                {jsonError && (
                                    <div className="absolute bottom-4 left-4 right-4 bg-red-500/90 text-white text-xs p-2 rounded shadow-lg backdrop-blur-sm">
                                        Erreur JSON: {jsonError}
                                    </div>
                                )}
                            </div>
                        </TabsContent>
                    </Tabs>

                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowDescModal(false)}>Fermer</Button>
                        <Button onClick={handleSaveDescription} disabled={isSavingDesc || !!jsonError} className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm">
                            {isSavingDesc ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                            Enregistrer
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* MODAL CONFIG API */}
            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API Gemini</DialogTitle>
                        <DialogDescription>Requis pour l'IA (Vision & Description).</DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
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
