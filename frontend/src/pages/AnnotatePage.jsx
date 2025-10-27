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
    const handleEditBubble = (bubble) => {
        setPendingAnnotation(bubble);
    };
    const { user, session } = useAuth();
    const { pageId } = useParams();
    const [page, setPage] = useState(null);
    const [error, setError] = useState(null);
    const [existingBubbles, setExistingBubbles] = useState([]);
    const [hoveredBubble, setHoveredBubble] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    const containerRef = useRef(null);
    const imageRef = useRef(null);

    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [rectangle, setRectangle] = useState(null);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [pendingAnnotation, setPendingAnnotation] = useState(null);

    const fetchBubbles = useCallback(() => {
        if (pageId && session?.access_token) {
            getBubblesForPage(pageId, session.access_token)
                .then(response => {
                    const sortedBubbles = response.data.sort((a, b) => a.order - b.order);
                    setExistingBubbles(sortedBubbles);
                })
                .catch(error => console.error("Erreur de chargement des bulles existantes", error));
        }
    }, [pageId, session]);

    useEffect(() => {
        if (pageId && session?.access_token) {
            getPageById(pageId, session.access_token)
                .then(response => setPage(response.data))
                .catch(error => setError("Impossible de charger les données de la page."));
            fetchBubbles();
        }
    }, [pageId, session, fetchBubbles]);

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
                    console.error("Erreur lors de l'analyse de la bulle:", error);
                    setError("L'analyse de la bulle a échoué.");
                })
                .finally(() => {
                    setIsSubmitting(false);
                });
        }
    }, [rectangle, pageId, session]);

    const handleDeleteBubble = async (bubbleId) => {
        if (window.confirm("Êtes-vous sûr de vouloir supprimer cette proposition ?")) {
            try {
                await deleteBubble(bubbleId, session.access_token);
                fetchBubbles();
            } catch (error) {
                alert("Erreur lors de la suppression.");
                console.error(error);
            }
        }
    };

    const handleSuccess = () => {
        setPendingAnnotation(null);
        setRectangle(null);
        fetchBubbles();
    };

    const getBubbleColorClass = (status) => {
        if (status === 'Proposé') return styles.proposedRectangle;
        if (status === 'Validé') return styles.validatedRectangle;
        return '';
    };

    const handleSubmitPage = async () => {
        if (window.confirm("Êtes-vous sûr de vouloir soumettre cette page pour validation ? Vous ne pourrez plus y ajouter de bulles.")) {
            try {
                const response = await submitPageForReview(pageId, session.access_token);
                setPage(response.data); // Mettre à jour le statut de la page affiché
                alert("Page soumise pour validation !");
            } catch (error) {
                alert("Erreur lors de la soumission de la page.");
                console.error(error);
            }
        }
    };

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
        // Prevent drawing if the page is not in a modifiable state
        if (page?.statut !== 'not_started' && page?.statut !== 'in_progress') return;
        event.preventDefault();
        setIsDrawing(true);
        const coords = getContainerCoords(event);
        setStartPoint(coords);
        setEndPoint(coords);
        setRectangle(null); // Clear previous rectangle data
        setPendingAnnotation(null); // Close modal if open
    };

    const handleMouseMove = (event) => {
        const container = containerRef.current;
        if (container) {
            const rect = container.getBoundingClientRect();
            setMousePos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        }
        if (!isDrawing) return;
        event.preventDefault();
        setEndPoint(getContainerCoords(event));
    };

    const handleMouseUp = (event) => {
        if (!isDrawing) return;
        event.preventDefault();
        setIsDrawing(false);
        const imageEl = imageRef.current;
        if (!imageEl || !startPoint || !endPoint) return; // Check startPoint & endPoint too

        // Ensure naturalWidth is loaded and valid
        if (imageEl.naturalWidth === 0 || imageEl.naturalHeight === 0) {
            console.warn("Image natural dimensions not available yet.");
            return;
        }

        const originalWidth = imageEl.naturalWidth;
        const displayedWidth = imageEl.offsetWidth;
        // Check for displayedWidth being zero if image hasn't rendered fully
        if (displayedWidth === 0) return;

        const scale = originalWidth / displayedWidth;

        // Ensure startPoint and endPoint are valid
        const currentEndPoint = getContainerCoords(event) || endPoint; // Use last known if event coords are null

        const unscaledRect = {
            x: Math.min(startPoint.x, currentEndPoint.x),
            y: Math.min(startPoint.y, currentEndPoint.y),
            w: Math.abs(startPoint.x - currentEndPoint.x),
            h: Math.abs(startPoint.y - currentEndPoint.y),
        };

        // Only process if the rectangle is reasonably sized
        if (unscaledRect.w > 5 && unscaledRect.h > 5) {
            const finalRect = {
                x: Math.round(unscaledRect.x * scale),
                y: Math.round(unscaledRect.y * scale),
                w: Math.round(unscaledRect.w * scale),
                h: Math.round(unscaledRect.h * scale),
            };
            setRectangle(finalRect);
        } else {
            // Reset points if rectangle is too small to avoid accidental single clicks
            setStartPoint(null);
            setEndPoint(null);
        }
    };


    const getRectangleStyle = () => {
        if (!isDrawing || !startPoint || !endPoint) return { display: 'none' };
        const left = Math.min(startPoint.x, endPoint.x);
        const top = Math.min(startPoint.y, endPoint.y);
        const width = Math.abs(startPoint.x - endPoint.x);
        const height = Math.abs(startPoint.y - endPoint.y);
        return { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
    };

    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                if (oldIndex === -1 || newIndex === -1) return bubbles; // Safety check

                const newOrder = arrayMove(bubbles, oldIndex, newIndex);

                // Update API with new order
                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(orderedBubblesForApi, session.access_token).catch(err => {
                    console.error("Failed to save new order:", err);
                    // Optionally revert state or show error message
                    alert("Erreur lors de la sauvegarde du nouvel ordre.");
                    return bubbles; // Revert to previous state on error
                });

                return newOrder; // Optimistic UI update
            });
        }
    };

    if (error) return <div><p style={{ color: 'red' }}>{error}</p><Link to="/">Retour</Link></div>;
    if (!page) return <div>Chargement...</div>;

    // Determine Tome/Chapter number safely
    const tomeNumber = page.chapitres?.tomes?.numero || '?';
    const chapterNumber = page.chapitres?.numero || '?';

    return (
        <div className={styles.container}>
            <div className={styles.subHeader}>
                <h2>Annotation - T{tomeNumber} C{chapterNumber} P{page.numero_page} (Statut: {page.statut})</h2>
                <div>
                    <button
                        onClick={handleSubmitPage}
                        disabled={page.statut !== 'not_started' && page.statut !== 'in_progress'}
                    >
                        Soumettre la page pour vérification
                    </button>
                    <Link to="/">Retour Bibliothèque</Link>
                </div>
            </div>

            <div className={styles.pageLayout}>
                <main className={styles.mainContent}>
                     <div
                        ref={containerRef}
                        className={styles.imageContainer}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp} // Keep MouseLeave for robustness
                    >
                        <img ref={imageRef} src={page.url_image} alt={`Page ${page.numero_page}`} className={styles.mangaImage} draggable="false" />

                        {isDrawing && <div style={getRectangleStyle()} className={styles.drawingRectangle} />}

                        {existingBubbles.map((bubble, index) => {
                            const imageEl = imageRef.current;
                             // Check naturalWidth validity
                            if (!imageEl || !imageEl.naturalWidth || imageEl.naturalWidth === 0) return null;
                            const scale = imageEl.offsetWidth / imageEl.naturalWidth;
                            const style = {
                                left: `${bubble.x * scale}px`,
                                top: `${bubble.y * scale}px`,
                                width: `${bubble.w * scale}px`,
                                height: `${bubble.h * scale}px`,
                            };
                            return (
                                <div
                                    key={bubble.id}
                                    style={style}
                                    className={`${styles.existingRectangle} ${getBubbleColorClass(bubble.statut)}`}
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                >
                                    <span className={styles.bubbleNumber}>{index + 1}</span>
                                </div>
                            );
                        })}

                        {hoveredBubble && (
                            <div className={styles.tooltip} style={{ transform: `translate(${mousePos.x + 15}px, ${mousePos.y + 15}px)` }}>
                                {hoveredBubble.texte_propose}
                            </div>
                        )}
                    </div>
                    {isSubmitting && <div className={styles.loadingMessage}>Analyse OCR en cours...</div>}

                    <Modal isOpen={!!pendingAnnotation} onClose={() => setPendingAnnotation(null)}>
                        <ValidationForm annotationData={pendingAnnotation} onValidationSuccess={handleSuccess} />
                    </Modal>
                </main>

                <aside className={styles.sidebar}>
                    <h3>Bulles ({existingBubbles.length})</h3>
                    <DndContext
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={existingBubbles.map(b => b.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <ul className={styles.bubbleList}>
                                {existingBubbles.map((bubble, index) => (
                                    <SortableBubbleItem
                                        key={bubble.id}
                                        id={bubble.id} // Ensure id is passed for dnd-kit
                                        bubble={bubble}
                                        index={index}
                                        user={user}
                                        onEdit={handleEditBubble}
                                        onDelete={handleDeleteBubble}
                                        // Disable drag if page is not modifiable
                                        disabled={page.statut !== 'not_started' && page.statut !== 'in_progress'}
                                    />
                                ))}
                            </ul>
                        </SortableContext>
                    </DndContext>
                </aside>
            </div>
        </div>
    );
};

export default AnnotatePage;