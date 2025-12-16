import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getPageById, getBubblesForPage, approvePage, rejectPage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import styles from './PageReview.module.css';
import Modal from '../components/Modal';
import ValidationForm from '../components/ValidationForm';

const PageReview = () => {
    const { pageId } = useParams();
    const navigate = useNavigate();
    const { session } = useAuth();

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
        const token = session?.access_token;
        if (!pageId || !token) return;

        try {
            const [pageRes, bubblesRes] = await Promise.all([
                getPageById(pageId, token),
                getBubblesForPage(pageId, token)
            ]);
            setPage(pageRes.data);
            const sortedBubbles = bubblesRes.data.sort((a, b) => a.order - b.order);
            setBubbles(sortedBubbles);
        } catch (err) {
            console.error("Erreur chargement données:", err);
            alert("Impossible de charger la page.");
        } finally {
            setLoading(false);
        }
    }, [pageId, session]);

    useEffect(() => {
        setLoading(true);
        fetchPageData();
    }, [fetchPageData]);

    const handleApprove = async () => {
        if (window.confirm("Confirmer l'approbation de cette page ?")) {
             try {
                 await approvePage(pageId, session.access_token);
                 navigate('/moderation');
             } catch (error) {
                 alert("Erreur technique lors de l'approbation.");
                 console.error(error);
             }
        }
    };

    const handleReject = async () => {
        const reason = window.prompt("Motif du rejet (optionnel) :");
        if (reason !== null) {
            try {
                await rejectPage(pageId, session.access_token, reason);
                navigate('/moderation');
            } catch (error) {
                alert("Erreur technique lors du rejet.");
                console.error(error);
            }
        }
    };

    const handleEditClick = (bubble) => {
        setEditingBubble(bubble);
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

    if (loading) return <div style={{padding: '2rem', textAlign: 'center', color: '#666'}}>Chargement de l'interface de vérification...</div>;
    if (!page) return <div style={{padding: '2rem', color: 'red'}}>Page introuvable.</div>;

    const tomeNumber = page.chapitres?.tomes?.numero || '?';
    const chapterNumber = page.chapitres?.numero || '?';

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerInfo}>
                    <h2>Vérification Page {page.numero_page}</h2>
                    <div className={styles.headerMeta}>Tome {tomeNumber} - Chapitre {chapterNumber}</div>
                </div>
                <div className={styles.actions}>
                    <Link to="/moderation" className={styles.backLink}>Annuler / Retour</Link>
                    <button onClick={handleReject} className={styles.rejectButton}>Refuser la page</button>
                    <button onClick={handleApprove} className={styles.approveButton}>Valider la page</button>
                </div>
            </header>

            <div className={styles.pageLayout}>
                <main className={styles.mainContent}>
                    <div
                        ref={imageContainerRef}
                        className={styles.imageContainer}
                        onMouseMove={handleMouseMove}
                        onMouseLeave={() => setHoveredBubble(null)}
                    >
                        <img
                            ref={imageRef}
                            src={page.url_image}
                            alt={`Page ${page.numero_page}`}
                            className={styles.mangaImage}
                            onLoad={(e) => setImageDimensions({
                                width: e.target.offsetWidth,
                                naturalWidth: e.target.naturalWidth
                            })}
                        />

                        {imageDimensions && bubbles.map((bubble, index) => {
                            const scale = imageDimensions.width / imageDimensions.naturalWidth;
                            if (!scale || isNaN(scale)) return null;

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
                                    className={styles.existingRectangle}
                                    onMouseEnter={() => setHoveredBubble(bubble)}
                                    onMouseLeave={() => setHoveredBubble(null)}
                                    onClick={() => handleEditClick(bubble)}
                                    title="Cliquez pour corriger"
                                >
                                    <span className={styles.bubbleNumber}>{index + 1}</span>
                                </div>
                            );
                        })}

                        {hoveredBubble && (
                            <div
                                className={styles.tooltip}
                                style={{
                                    left: 0, top: 0,
                                    transform: `translate(${mousePos.x + 15}px, ${mousePos.y + 15}px)`
                                }}
                            >
                                <strong>#{bubbles.findIndex(b => b.id === hoveredBubble.id) + 1}</strong><br/>
                                {hoveredBubble.texte_propose}
                            </div>
                        )}
                    </div>
                </main>

                <aside className={styles.sidebar}>
                    <div className={styles.sidebarHeader}>
                        <h3>Textes Validés <span className={styles.bubbleCount}>{bubbles.length}</span></h3>
                    </div>

                    <div className={styles.bubbleListContainer}>
                        <ul className={styles.bubbleList}>
                            {bubbles.map((bubble, index) => (
                                <li key={bubble.id} className={styles.bubbleListItem}>
                                    <span className={styles.listIndex}>{index + 1}</span>
                                    <div style={{flex: 1}}>
                                        <p className={styles.listText}>{bubble.texte_propose}</p>

                                        <button
                                            className={styles.miniEditBtn}
                                            onClick={() => handleEditClick(bubble)}
                                            title="Corriger le texte"
                                        >
                                            Corriger
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </aside>
            </div>

            <Modal
                isOpen={!!editingBubble}
                onClose={() => setEditingBubble(null)}
                title="Correction Rapide"
            >
                <ValidationForm
                    annotationData={editingBubble}
                    onValidationSuccess={handleEditSuccess}
                    onCancel={() => setEditingBubble(null)}
                />
            </Modal>
        </div>
    );
};

export default PageReview;