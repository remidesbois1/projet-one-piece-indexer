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
                setPage(response.data);
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
        event.preventDefault();
        setIsDrawing(true);
        const coords = getContainerCoords(event);
        setStartPoint(coords);
        setEndPoint(coords);
        setRectangle(null);
    };

    const handleMouseMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMousePos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        if (!isDrawing) return;
        event.preventDefault();
        setEndPoint(getContainerCoords(event));
    };

    const handleMouseUp = (event) => {
        if (!isDrawing) return;
        event.preventDefault();
        setIsDrawing(false);
        const imageEl = imageRef.current;
        if (!imageEl) return;
        const originalWidth = imageEl.naturalWidth;
        const displayedWidth = imageEl.offsetWidth;
        const scale = originalWidth > 0 ? originalWidth / displayedWidth : 1;
        const unscaledRect = {
            x: Math.min(startPoint.x, endPoint.x),
            y: Math.min(startPoint.y, endPoint.y),
            w: Math.abs(startPoint.x - endPoint.x),
            h: Math.abs(startPoint.y - endPoint.y),
        };
        if (unscaledRect.w > 5 && unscaledRect.h > 5) {
            const finalRect = {
                x: Math.round(unscaledRect.x * scale),
                y: Math.round(unscaledRect.y * scale),
                w: Math.round(unscaledRect.w * scale),
                h: Math.round(unscaledRect.h * scale),
            };
            setRectangle(finalRect);
        }
    };

    const getRectangleStyle = () => {
        if (!startPoint || !endPoint) return { display: 'none' };
        const left = Math.min(startPoint.x, endPoint.x);
        const top = Math.min(startPoint.y, endPoint.y);
        const width = Math.abs(startPoint.x - endPoint.x);
        const height = Math.abs(startPoint.y - endPoint.y);
        return { left, top, width, height };
    };

    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active.id !== over.id) {
            setExistingBubbles((bubbles) => {
                const oldIndex = bubbles.findIndex(b => b.id === active.id);
                const newIndex = bubbles.findIndex(b => b.id === over.id);
                const newOrder = arrayMove(bubbles, oldIndex, newIndex);

                const orderedBubblesForApi = newOrder.map((b, index) => ({ id: b.id, order: index + 1 }));
                reorderBubbles(orderedBubblesForApi, session.access_token).catch(err => {
                    console.error("Failed to save new order:", err);
                });
                
                return newOrder;
            });
        }
    };

    if (error) return <div><p style={{ color: 'red' }}>{error}</p><Link to="/">Retour</Link></div>;
    if (!page) return <div>Chargement...</div>;

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <h2>Annotation - Page {page.numero_page} (Statut: {page.statut})</h2>
                <div>
                    <button
                        onClick={handleSubmitPage}
                        disabled={page.statut !== 'not_started' && page.statut !== 'in_progress'}
                    >
                        Soumettre la page pour vérification
                    </button>
                    <Link to="/" style={{ marginLeft: '1rem' }}>Retour</Link>
                </div>
            </header>
            
            <div className={styles.pageLayout}>
                <main className={styles.mainContent}>
                    <div
                        ref={containerRef}
                        className={styles.imageContainer}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp}
                    >
                        <img ref={imageRef} src={page.url_image} alt={`Page ${page.numero_page}`} className={styles.mangaImage} draggable="false" />
                        
                        {isDrawing && <div style={getRectangleStyle()} className={styles.drawingRectangle} />}

                        {existingBubbles.map((bubble, index) => {
                            const imageEl = imageRef.current;
                            if (!imageEl || !imageEl.naturalWidth) return null;
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
                    <h3>Bulles sur cette page ({existingBubbles.length})</h3>
                    <DndContext
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={existingBubbles.map(b => b.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <ul>
                                {existingBubbles.map((bubble, index) => (
                                    <SortableBubbleItem 
                                        key={bubble.id}
                                        id={bubble.id}
                                        bubble={bubble}
                                        index={index}
                                        user={user}
                                        // On passe la nouvelle fonction au composant
                                        onEdit={handleEditBubble} 
                                        onDelete={handleDeleteBubble}
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