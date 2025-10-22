import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPendingBubbles, validateBubble, rejectBubble } from '../services/api';
import BubbleReviewItem from './BubbleReviewItem';

const BubbleReviewList = () => {
    const { session } = useAuth();
    const [pendingBubbles, setPendingBubbles] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    const token = session?.access_token;

    useEffect(() => {
        if (!token) return;

        setIsLoading(true);
        getPendingBubbles(token)
            .then(response => setPendingBubbles(response.data))
            .catch(err => {
                console.error(err);
                setError("Erreur lors de la récupération des propositions de bulles.");
            })
            .finally(() => setIsLoading(false));
    }, [token]);

    const handleAction = async (action, id) => {
        if (!token) return;
        try {
            if (action === 'validate') {
                await validateBubble(id, token);
            } else if (action === 'reject') {
                await rejectBubble(id, token);
            }
            setPendingBubbles(currentBubbles => currentBubbles.filter(b => b.id !== id));
        } catch (err) {
            alert(`Erreur lors de l'action de modération.`);
            console.error(err);
        }
    };

    if (isLoading) return <p>Chargement des propositions...</p>;
    if (error) return <p style={{ color: 'red' }}>{error}</p>;

    return (
        <div>
            <p><strong>{pendingBubbles.length} bulle(s)</strong> en attente de validation.</p>
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
        </div>
    );
};

export default BubbleReviewList;