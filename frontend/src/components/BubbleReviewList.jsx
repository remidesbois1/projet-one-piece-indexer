import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPendingBubbles, validateBubble, rejectBubble } from '../services/api';
import BubbleReviewItem from './BubbleReviewItem';

const RESULTS_PER_PAGE = 5;

const BubbleReviewList = () => {
    const { session } = useAuth();
    const [pendingBubbles, setPendingBubbles] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    const token = session?.access_token;

    const fetchPending = (pageToFetch) => {
        if (!token) return;
        setIsLoading(true);
        getPendingBubbles(token, pageToFetch, RESULTS_PER_PAGE)
            .then(response => {
                setPendingBubbles(response.data.results);
                setTotalCount(response.data.totalCount);
                setCurrentPage(pageToFetch);
            })
            .catch(err => {
                console.error(err);
                setError("Erreur lors de la récupération des propositions.");
            })
            .finally(() => setIsLoading(false));
    };

    useEffect(() => {
        if (token) {
            fetchPending(1);
        }
    }, [token]);

    const handleAction = async (action, id) => {
        if (!token) return;
        try {
            if (action === 'validate') {
                await validateBubble(id, token);
            } else if (action === 'reject') {
                await rejectBubble(id, token);
            }
            fetchPending(currentPage);
        } catch (err) {
            alert(`Erreur lors de l'action de modération.`);
            console.error(err);
        }
    };
    
    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    if (isLoading) return <p>Chargement des propositions...</p>;
    if (error) return <p style={{ color: 'red' }}>{error}</p>;

    return (
        <div>
            <p><strong>{totalCount} bulle(s)</strong> en attente de validation.</p>
            {pendingBubbles.length === 0 ? (
                <p>Aucune proposition pour le moment.</p>
            ) : (
                pendingBubbles.map(bubble => (
                    <BubbleReviewItem 
                        key={bubble.id}
                        bubble={bubble}
                        onAction={handleAction}
                    />
                ))
            )}
            
            {totalPages > 1 && (
                <div style={{display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem'}}>
                    <button onClick={() => fetchPending(currentPage - 1)} disabled={currentPage === 1}>
                        Précédent
                    </button>
                    <span>Page {currentPage} sur {totalPages}</span>
                    <button onClick={() => fetchPending(currentPage + 1)} disabled={currentPage === totalPages}>
                        Suivant
                    </button>
                </div>
            )}
        </div>
    );
};

export default BubbleReviewList;