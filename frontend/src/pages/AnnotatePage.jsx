import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, reorderBubbles, analyseBubble } from '../services/api';
import ValidationForm from '../components/ValidationForm';
import ApiKeyForm from '../components/ApiKeyForm';
import { useAuth } from '../context/AuthContext';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { SortableBubbleItem } from '../components/SortableBubbleItem';
import DraggableWrapper from '../components/DraggableWrapper';

// Shadcn Components
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";

// Icons
import { ArrowLeft, Send, KeyRound, Loader2, MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";

const AnnotatePage = () => {
    const { user, session } = useAuth();
    const { pageId } = useParams();
    
    // --- Data State ---
    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [error, setError] = useState(null);
    
    // --- UI State ---
    const [hoveredBubble, setHoveredBubble] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [pendingAnnotation, setPendingAnnotation] = useState(null); 
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    
    // --- Drawing State ---
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [rectangle, setRectangle] = useState(null);
    const [imageDimensions, setImageDimensions] = useState(null);
    const [retryTrigger, setRetryTrigger] = useState(0);

    const containerRef = useRef(null);
    const imageRef = useRef(null);

    // Charger les bulles
    const fetchBubbles = useCallback(() => {
        if (pageId && session?.access_token) {
            getBubblesForPage(pageId, session.access_token)
                .then(response => {
                    const sortedBubbles = response.data.sort((a, b) => a.order - b.order);
                    setExistingBubbles(sortedBubbles);
                })
                .catch(error => console.error("Erreur chargement bulles", error));
        }
    }, [pageId, session]);

    // Charger la page
    useEffect(() => {
        if (pageId && session?.access_token) {
            getPageById(pageId, session.access_token)
                .then(response => setPage(response.data))
                .catch(error => setError("Impossible de charger la page."));
            fetchBubbles();
        }
    }, [pageId, session?.access_token, fetchBubbles]);

    // Logique OCR (Google Vision / Gemini)
    useEffect(() => {
        const token = session?.access_token;
        if (rectangle && token) {
            const storedKey = localStorage.getItem('google_api_key');
            if (!storedKey) {
                setShowApiKeyModal(true);
                return;
            }

            setIsSubmitting(true);
            setPendingAnnotation(null);
            
            const analysisData = {
                id_page: parseInt(pageId, 10),
                ...rectangle,
            };

            analyseBubble(analysisData, token, storedKey)
                .then(response => {
                    setPendingAnnotation({
                        ...analysisData,
                        texte_propose: response.data.texte_propose
                    });
                })
                .catch(error => {
                    console.error("Erreur OCR:", error);
                    if (error.response?.status === 400 && error.response?.data?.error?.includes('Clé')) {
                        alert("Clé API invalide.");
                        localStorage.removeItem('google_api_key');
                        setShowApiKeyModal(true);
                    } else {
                        alert("Échec de l'analyse.");
                        setRectangle(null);
                    }
                })
                .finally(() => {
                    setIsSubmitting(false);
                });
        }
    }, [rectangle, pageId, session, retryTrigger]);

    const handleSaveApiKey = (key) => {
        localStorage.setItem('google_api_key', key);
        setShowApiKeyModal(false);
        setRetryTrigger(prev => prev + 1);
    };

    const handleEditBubble = (bubble) => setPendingAnnotation(bubble);

    const handleDeleteBubble = async (bubbleId) => {
        if (window.confirm("Supprimer cette annotation ?")) {
            try {
                await deleteBubble(bubbleId, session.access_token);
                fetchBubbles();
            } catch (error) { alert("Erreur lors de la suppression."); }
        }
    };

    const handleSuccess = () => {
        setPendingAnnotation(null);
        setRectangle(null);
        fetchBubbles();
    };

    const handleSubmitPage = async () => {
        if (window.confirm("Envoyer pour validation ?")) {
            try {
                const response = await submitPageForReview(pageId, session.access_token);
                setPage(response.data);
            } catch (error) { alert("Erreur soumission."); }
        }
    };

    // --- LOGIQUE CANVAS / SOURIS ---

    const getContainerCoords = (event) => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    };

    const handleMouseDown = (event) => {
        if (page?.statut !== 'not_started' && page?.statut !== 'in_progress') return;
        if (isSubmitting || showApiKeyModal) return;
        
        event.preventDefault();
        setIsDrawing(true);
        const coords = getContainerCoords(event);
        setStartPoint(coords);
        setEndPoint(coords);
        setRectangle(null); 
        setPendingAnnotation(null);
    };

    const handleMouseMove = (event) => {
        const coords = getContainerCoords(event);
        if (coords) setMousePos(coords);
        if (!isDrawing) return;
        event.preventDefault();
        setEndPoint(coords);
    };

    const handleMouseUp = (event) => {
        if (!isDrawing) return;
        event.preventDefault();
        setIsDrawing(false);
        
        const imageEl = imageRef.current;
        if (!imageEl || !startPoint || !endPoint || imageEl.naturalWidth === 0) return;

        const scale = imageEl.naturalWidth / imageEl.offsetWidth;
        const currentEndPoint = getContainerCoords(event) || endPoint; 

        const unscaledRect = {
            x: Math.min(startPoint.x, currentEndPoint.x),
            y: Math.min(startPoint.y, currentEndPoint.y),
            w: Math.abs(startPoint.x - currentEndPoint.x),
            h: Math.abs(startPoint.y - currentEndPoint.y),
        };

        if (unscaledRect.w > 10 && unscaledRect.h > 10) {
            setRectangle({
                x: Math.round(unscaledRect.x * scale),
                y: Math.round(unscaledRect.y * scale),
                w: Math.round(unscaledRect.w * scale),
                h: Math.round(unscaledRect.h * scale),
            });
        } else {
            setStartPoint(null);
            setEndPoint(null);
        }
    };

    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);
                
                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(orderedBubblesForApi, session.access_token).catch(err => {
                    console.error("Erreur ordre", err);
                    fetchBubbles();
                });
                return newOrder; 
            });
        }
    };

    if (error) return <div className="p-8 text-red-500">{error}</div>;
    if (!page) return <div className="flex h-screen items-center justify-center text-slate-500">Chargement...</div>;

    const canEdit = page.statut === 'not_started' || page.statut === 'in_progress';

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-slate-50">
            {/* --- HEADER --- */}
            <header className="flex-none h-16 border-b border-slate-200 bg-white px-6 flex items-center justify-between z-20 shadow-sm">
                <div className="flex items-center gap-4">
                    <Link to="/">
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4 mr-2" /> Retour
                        </Button>
                    </Link>
                    <div className="h-6 w-px bg-slate-200" />
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">
                            {page.chapitres?.tomes?.titre || 'Tome'} - Chapitre {page.chapitres?.numero}
                        </h2>
                        <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
                            Page {page.numero_page} 
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{page.statut}</Badge>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <Button 
                        variant="secondary" 
                        size="sm"
                        onClick={() => setShowApiKeyModal(true)}
                        className="text-xs h-8"
                    >
                        <KeyRound className="h-3 w-3 mr-2" /> Clé IA
                    </Button>

                    <Button
                        className="bg-slate-900 hover:bg-slate-800"
                        onClick={handleSubmitPage}
                        disabled={!canEdit}
                    >
                        <Send className="h-3 w-3 mr-2" /> Soumettre
                    </Button>
                </div>
            </header>

            {/* --- WORKSPACE --- */}
            <div className="flex flex-1 overflow-hidden">
                <main className="flex-1 bg-slate-200/50 overflow-auto flex justify-center p-8 relative cursor-default">
                     <div
                        ref={containerRef}
                        className={cn(
                            "relative inline-block bg-white shadow-xl select-none max-w-none h-fit",
                            canEdit ? "cursor-crosshair" : "cursor-default"
                        )}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp} 
                    >
                        <img 
                            ref={imageRef} 
                            src={page.url_image} 
                            alt={`Page ${page.numero_page}`} 
                            className="block max-w-full h-auto pointer-events-none"
                            onLoad={(e) => setImageDimensions({
                                width: e.target.offsetWidth,
                                naturalWidth: e.target.naturalWidth
                            })}
                        />

                        {/* Loading Overlay */}
                        {isSubmitting && (
                            <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-50 flex flex-col items-center justify-center text-slate-800 font-semibold">
                                <Loader2 className="h-10 w-10 animate-spin mb-2 text-slate-900" />
                                <span>Analyse IA en cours...</span>
                            </div>
                        )}

                        {/* Rectangle en cours de dessin */}
                        {isDrawing && startPoint && endPoint && (
                            <div 
                                style={{
                                    left: Math.min(startPoint.x, endPoint.x),
                                    top: Math.min(startPoint.y, endPoint.y),
                                    width: Math.abs(startPoint.x - endPoint.x),
                                    height: Math.abs(startPoint.y - endPoint.y),
                                }} 
                                className="absolute border-2 border-dashed border-red-500 bg-red-500/10 pointer-events-none z-20" 
                            />
                        )}

                        {/* Bulles existantes */}
                        {imageDimensions && existingBubbles.map((bubble, index) => {
                            const scale = imageDimensions.width / imageDimensions.naturalWidth;
                            if (!scale) return null; 

                            const style = {
                                left: `${bubble.x * scale}px`,
                                top: `${bubble.y * scale}px`,
                                width: `${bubble.w * scale}px`,
                                height: `${bubble.h * scale}px`,
                            };
                            
                            const colorClass = bubble.statut === 'Validé' 
                                ? "border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20" 
                                : "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20";

                            return (
                                <div
                                    key={bubble.id}
                                    style={style}
                                    className={cn("absolute border-2 z-10 transition-colors cursor-pointer group", colorClass)}
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                    onClick={(e) => {
                                        // On arrête la propagation pour ne pas déclencher le dessin
                                        e.stopPropagation();
                                        handleEditBubble(bubble);
                                    }}
                                >
                                    <div className={cn(
                                        "absolute -top-6 -left-[2px] text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm",
                                        bubble.statut === 'Validé' ? "bg-emerald-500" : "bg-amber-500"
                                    )}>
                                        #{index + 1}
                                    </div>
                                </div>
                            );
                        })}

                        {/* Tooltip custom suiveur */}
                        {hoveredBubble && (
                             <div
                                className="fixed z-50 pointer-events-none bg-slate-900/95 text-white p-3 rounded-lg shadow-xl border border-slate-700 backdrop-blur-sm max-w-[300px]"
                                style={{
                                    left: 0, top: 0,
                                    transform: `translate(${mousePos.x + 20 + containerRef.current?.getBoundingClientRect().left}px, ${mousePos.y + 20 + containerRef.current?.getBoundingClientRect().top}px)`
                                }}
                            >
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                                    Bulle #{existingBubbles.findIndex(b => b.id === hoveredBubble.id) + 1}
                                </div>
                                <p className="text-sm font-medium leading-relaxed">
                                    {hoveredBubble.texte_propose}
                                </p>
                            </div>
                        )}
                    </div>
                </main>

                {/* --- SIDEBAR --- */}
                <aside className="w-[380px] bg-white border-l border-slate-200 flex flex-col h-full overflow-hidden z-10 shadow-lg">
                    <div className="flex-none p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                        <h3 className="font-semibold text-slate-900">Annotations</h3>
                        <Badge variant="secondary">{existingBubbles.length}</Badge>
                    </div>
                    
                    <ScrollArea className="flex-1 w-full h-full">
                        {/* 1. w-full : prend toute la largeur
                        2. px-4 : padding horizontal standard
                        3. pb-20 : espace pour le scroll en bas
                        4. overflow-x-hidden : COUPE tout ce qui oserait dépasser horizontalement
                        */}
                        <div className="flex flex-col w-full max-w-full px-4 py-4 pb-20 overflow-x-hidden">
                            {existingBubbles.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-10 text-center border-2 border-dashed border-slate-200 rounded-lg bg-slate-50/50 text-slate-500">
                                    <MousePointer2 className="h-8 w-8 mb-2 text-slate-300" />
                                    <p className="text-sm font-medium">Aucune annotation</p>
                                    <p className="text-xs mt-1">Dessinez un rectangle sur l'image<br/>pour commencer.</p>
                                </div>
                            ) : (
                                <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                                    <SortableContext
                                        items={existingBubbles.map(b => b.id)}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        <ul className="flex flex-col gap-3 w-full max-w-full">
                                            {existingBubbles.map((bubble, index) => (
                                                <SortableBubbleItem
                                                    key={bubble.id}
                                                    id={bubble.id} 
                                                    bubble={bubble}
                                                    index={index}
                                                    user={user}
                                                    onEdit={handleEditBubble}
                                                    onDelete={handleDeleteBubble}
                                                    disabled={!canEdit}
                                                />
                                            ))}
                                        </ul>
                                    </SortableContext>
                                </DndContext>
                            )}
                        </div>
                    </ScrollArea>
                </aside>
            </div>

            {/* --- MODALS (DIALOGS) --- */}
            
            {/* 1. Validation / Édition (DRAGGABLE) */}
            <Dialog 
                open={!!pendingAnnotation && !isSubmitting} 
                onOpenChange={(open) => {
                    if(!open) {
                        setPendingAnnotation(null);
                        setRectangle(null);
                    }
                }}
            >
                {/* Conteneur invisible pour permettre le drag */}
                <DialogContent 
                    className="max-w-none w-full h-full bg-transparent border-0 shadow-none p-0 flex items-center justify-center pointer-events-none"
                    showCloseButton={false}
                >
                    {pendingAnnotation && (
                        <div className="pointer-events-auto">
                            <DraggableWrapper 
                                title={pendingAnnotation?.id ? "Modifier l'annotation" : "Nouvelle annotation"}
                                onClose={() => {
                                    setPendingAnnotation(null);
                                    setRectangle(null);
                                }}
                                className="w-full max-w-lg"
                            >
                                <div className="p-6">
                                    <ValidationForm 
                                        annotationData={pendingAnnotation} 
                                        onValidationSuccess={handleSuccess}
                                        onCancel={() => {
                                            setPendingAnnotation(null);
                                            setRectangle(null);
                                        }}
                                    />
                                </div>
                            </DraggableWrapper>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* 2. Clé API (STANDARD) */}
            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                     <DialogHeader>
                        <DialogTitle>Configuration API Google Vision</DialogTitle>
                        <DialogDescription>
                            Une clé API est requise pour la reconnaissance de texte.
                        </DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default AnnotatePage;