import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getPageById, getBubblesForPage, approvePage, rejectPage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import styles from './PageReview.module.css';

const PageReview = () => {
    const { pageId } = useParams();
    const navigate = useNavigate();
    const { session } = useAuth();
    const [page, setPage] = useState(null);
    const [bubbles, setBubbles] = useState([]);
    const imageRef = useRef(null);

    useEffect(() => {
        const token = session?.access_token;
        if (pageId && token) {
            getPageById(pageId, token).then(res => setPage(res.data));
            getBubblesForPage(pageId, token).then(res => setBubbles(res.data));
        }
    }, [pageId, session]);

    const handleApprove = async () => {
        if (window.confirm("Approuver cette page et toutes ses bulles ?")) {
            await approvePage(pageId, session.access_token);
            navigate('/moderation');
        }
    };

    const handleReject = async () => {
        if (window.confirm("Rejeter cette page ? Elle retournera au statut 'en cours' pour l'annotateur.")) {
            await rejectPage(pageId, session.access_token);
            navigate('/moderation');
        }
    };

    if (!page) return <div>Chargement de la page de vérification...</div>;

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <h2>Vérification - Page {page.numero_page} (Tome {page.chapitres?.tomes?.numero})</h2>
                <div className={styles.actions}>
                    <button onClick={handleApprove} className={styles.approveButton}>Approuver la Page</button>
                    <button onClick={handleReject} className={styles.rejectButton}>Rejeter la Page</button>
                    <Link to="/moderation">Retour</Link>
                </div>
            </header>

            <div className={styles.pageLayout}>
                <main className={styles.mainContent}>
                    <div className={styles.imageContainer}>
                        <img ref={imageRef} src={page.url_image} alt={`Page ${page.numero_page}`} className={styles.mangaImage} />
                        {bubbles.map((bubble, index) => {
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
                                <div key={bubble.id} style={style} className={styles.existingRectangle}>
                                    <span className={styles.bubbleNumber}>{index + 1}</span>
                                </div>
                            );
                        })}
                    </div>
                </main>

                <aside className={styles.sidebar}>
                    <h3>Bulles Validées ({bubbles.length})</h3>
                    <ul>
                        {bubbles.map((bubble, index) => (
                            <li key={bubble.id} className={styles.bubbleListItem}>
                                <span>{index + 1}.</span>
                                {bubble.texte_propose}
                            </li>
                        ))}
                    </ul>
                </aside>
            </div>
        </div>
    );
};

export default PageReview;