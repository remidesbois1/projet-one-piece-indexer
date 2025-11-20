import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById, getBubblesForPage, deleteBubble, submitPageForReview, reorderBubbles, analyseBubble } from '../services/api';
import ValidationForm from '../components/ValidationForm';
import { useAuth } from '../context/AuthContext';
import styles from './AnnotatePage.module.css';
import Modal from '../components/Modal';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { SortableBubbleItem } from '../components/SortableBubbleItem';

const AnnotatePage = () => {
    const { user, session } = useAuth();
    const { pageId } = useParams();
    
    // États de données
    const [page, setPage] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [error, setError] = useState(null);
    
    // États d'interaction UI
    const [hoveredBubble, setHoveredBubble] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [pendingAnnotation, setPendingAnnotation] = useState(null);

    // États de dessin
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [rectangle, setRectangle] = useState(null);
    const [imageDimensions, setImageDimensions] = useState(null);

    const containerRef = useRef(null);
    const imageRef = useRef(null);

    // --- 1. CHARGEMENT DES DONNÉES ---
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

    useEffect(() => {
        if (pageId && session?.access_token) {
            getPageById(pageId, session.access_token)
                .then(response => setPage(response.data))
                .catch(error => setError("Impossible de charger la page."));
            fetchBubbles();
        }
    }, [pageId, session, fetchBubbles]);

    // --- 2. LOGIQUE D'ANALYSE (OCR) ---
    useEffect(() => {
        const token = session?.access_token;
        if (rectangle && token) {
            setIsSubmitting(true);
            setPendingAnnotation(null);
            const analysisData = {
                id_page: parseInt(pageId, 10),
                ...rectangle,
            };
            analyseBubble(analysisData, token)
                .then(response => {
                    setPendingAnnotation({
                        ...analysisData,
                        texte_propose: response.data.texte_propose
                    });
                })
                .catch(error => {
                    console.error("Erreur OCR:", error);
                    alert("L'analyse de la zone a échoué. Veuillez réessayer.");
                    setRectangle(null); // Reset on error
                })
                .finally(() => {
                    setIsSubmitting(false);
                });
        }
    }, [rectangle, pageId, session]);

    // --- 3. GESTIONNAIRES D'ÉVÉNEMENTS ---
    const handleEditBubble = (bubble) => {
        setPendingAnnotation(bubble);
    };

    const handleDeleteBubble = async (bubbleId) => {
        if (window.confirm("Supprimer cette annotation ?")) {
            try {
                await deleteBubble(bubbleId, session.access_token);
                fetchBubbles();
            } catch (error) {
                alert("Erreur lors de la suppression.");
            }
        }
    };

    const handleSuccess = () => {
        setPendingAnnotation(null);
        setRectangle(null);
        fetchBubbles();
    };

    const handleSubmitPage = async () => {
        if (window.confirm("Confirmer la validation de la page ?")) {
            try {
                const response = await submitPageForReview(pageId, session.access_token);
                setPage(response.data);
                alert("Page envoyée pour validation !");
            } catch (error) {
                alert("Erreur lors de la soumission.");
            }
        }
    };

    // --- 4. LOGIQUE DE DESSIN (SOURIS) ---
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
        if (isSubmitting) return; // Bloquer si analyse en cours
        
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
        if (coords) setMousePos(coords); // Pour le tooltip

        if (!isDrawing) return;
        event.preventDefault();
        setEndPoint(coords);
    };

    const handleMouseUp = (event) => {
        if (!isDrawing) return;
        event.preventDefault();
        setIsDrawing(false);
        
        const imageEl = imageRef.current;
        if (!imageEl || !startPoint || !endPoint) return;

        // Calculs de mise à l'échelle
        if (imageEl.naturalWidth === 0) return;
        const scale = imageEl.naturalWidth / imageEl.offsetWidth;
        const currentEndPoint = getContainerCoords(event) || endPoint; 

        const unscaledRect = {
            x: Math.min(startPoint.x, currentEndPoint.x),
            y: Math.min(startPoint.y, currentEndPoint.y),
            w: Math.abs(startPoint.x - currentEndPoint.x),
            h: Math.abs(startPoint.y - currentEndPoint.y),
        };

        // Seuil minimum pour éviter les clics accidentels (10x10px)
        if (unscaledRect.w > 10 && unscaledRect.h > 10) {
            const finalRect = {
                x: Math.round(unscaledRect.x * scale),
                y: Math.round(unscaledRect.y * scale),
                w: Math.round(unscaledRect.w * scale),
                h: Math.round(unscaledRect.h * scale),
            };
            setRectangle(finalRect);
        } else {
            // Annuler si trop petit
            setStartPoint(null);
            setEndPoint(null);
        }
    };

    // Style dynamique du rectangle de dessin
    const getDrawingStyle = () => {
        if (!isDrawing || !startPoint || !endPoint) return { display: 'none' };
        const left = Math.min(startPoint.x, endPoint.x);
        const top = Math.min(startPoint.y, endPoint.y);
        const width = Math.abs(startPoint.x - endPoint.x);
        const height = Math.abs(startPoint.y - endPoint.y);
        return { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
    };

    // --- 5. DRAG AND DROP ---
    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);
                
                // Optimistic UI update
                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(orderedBubblesForApi, session.access_token).catch(err => {
                    console.error("Erreur ordre", err);
                    fetchBubbles(); // Revert on error
                });
                return newOrder; 
            });
        }
    };

    if (error) return <div className={styles.errorState}>{error} <Link to="/">Retour</Link></div>;
    if (!page) return <div className={styles.loadingState}>Chargement de la page...</div>;

    const canEdit = page.statut === 'not_started' || page.statut === 'in_progress';

    return (
        <div className={styles.container}>
            {/* --- HEADER --- */}
            <header className={styles.subHeader}>
                <div className={styles.headerInfo}>
                    <h2>Annoter : {page.chapitres?.tomes?.nom || 'Tome'} - Chapitre {page.chapitres?.numero}</h2>
                    <div className={styles.headerMeta}>Page {page.numero_page} • Statut: <span style={{fontWeight:'bold'}}>{page.statut}</span></div>
                </div>
                <div className={styles.headerActions}>
                    <Link to="/" className={styles.linkBack}>Retour Bibliothèque</Link>
                    <button
                        className={styles.btnPrimary}
                        onClick={handleSubmitPage}
                        disabled={!canEdit}
                        title={!canEdit ? "Page déjà validée ou en cours de revue" : "Terminer l'annotation"}
                    >
                        Soumettre la page
                    </button>
                </div>
            </header>

            <div className={styles.pageLayout}>
                {/* --- MAIN IMAGE AREA --- */}
                <main className={styles.mainContent}>
                     <div
                        ref={containerRef}
                        className={styles.imageContainer}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp} 
                    >
                        <img 
                            ref={imageRef} 
                            src={page.url_image} 
                            alt={`Page ${page.numero_page}`} 
                            className={styles.mangaImage} 
                            draggable="false"
                            onLoad={(e) => setImageDimensions({
                                width: e.target.offsetWidth,
                                naturalWidth: e.target.naturalWidth
                            })}
                        />

                        {/* Loading Overlay (OCR) */}
                        {isSubmitting && (
                            <div className={styles.loadingOverlay}>
                                <div className={styles.spinner}></div>
                                <span>Analyse intelligente en cours...</span>
                            </div>
                        )}

                        {/* Drawing Rectangle */}
                        {isDrawing && <div style={getDrawingStyle()} className={styles.drawingRectangle} />}

                        {/* Existing Bubbles Overlay */}
                        {imageDimensions && existingBubbles.map((bubble, index) => {
                            const scale = imageDimensions.width / imageDimensions.naturalWidth;
                            if (!scale) return null; 

                            const style = {
                                left: `${bubble.x * scale}px`,
                                top: `${bubble.y * scale}px`,
                                width: `${bubble.w * scale}px`,
                                height: `${bubble.h * scale}px`,
                            };
                            
                            const statusClass = bubble.statut === 'Validé' ? styles.validatedRectangle : styles.proposedRectangle;

                            return (
                                <div
                                    key={bubble.id}
                                    style={style}
                                    className={`${styles.existingRectangle} ${statusClass}`}
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                >
                                    <span className={styles.bubbleNumber}>{index + 1}</span>
                                </div>
                            );
                        })}

                        {/* Tooltip */}
                        {hoveredBubble && (
                            <div 
                                className={styles.tooltip} 
                                style={{ 
                                    left: 0, top: 0,
                                    transform: `translate(${mousePos.x + 15}px, ${mousePos.y + 15}px)` 
                                }}
                            >
                                <strong>#{existingBubbles.findIndex(b => b.id === hoveredBubble.id) + 1}</strong><br/>
                                {hoveredBubble.texte_propose || <em>Aucun texte détecté</em>}
                            </div>
                        )}
                    </div>
                </main>

                {/* --- SIDEBAR --- */}
                <aside className={styles.sidebar}>
                    <div className={styles.sidebarHeader}>
                        <h3>Annotations <span className={styles.bubbleCount}>{existingBubbles.length}</span></h3>
                    </div>
                    
                    <div className={styles.bubbleListContainer}>
                        {existingBubbles.length === 0 ? (
                            <div className={styles.emptyState}>
                                <p>Aucune bulle détectée.</p>
                                <p>Dessinez un rectangle sur l'image pour commencer.</p>
                            </div>
                        ) : (
                            <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                                <SortableContext
                                    items={existingBubbles.map(b => b.id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    <ul className={styles.bubbleList}>
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
                </aside>
            </div>

            {/* --- MODALS --- */}
            <Modal isOpen={!!pendingAnnotation && !isSubmitting} onClose={() => {
                setPendingAnnotation(null);
                setRectangle(null); // Clean up selection if cancelled
            }}>
                <ValidationForm 
                    annotationData={pendingAnnotation} 
                    onValidationSuccess={handleSuccess} 
                />
            </Modal>
        </div>
    );
};

export default AnnotatePage;