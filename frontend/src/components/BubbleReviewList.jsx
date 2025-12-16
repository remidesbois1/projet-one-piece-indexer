import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPendingBubbles, validateBubble, rejectBubble } from '../services/api';
import BubbleReviewItem from './BubbleReviewItem';
import Modal from './Modal';
import ValidationForm from './ValidationForm';

const RESULTS_PER_PAGE = 5;

const BubbleReviewList = () => {
    const { session } = useAuth();
    const [pendingBubbles, setPendingBubbles] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    
    // État pour l'édition
    const [editingBubble, setEditingBubble] = useState(null);

    const token = session?.access_token;

    const fetchPending = (pageToFetch) => {
        if (!token) return;
        setIsLoading(true);
        getPendingBubbles(token, pageToFetch, RESULTS_PER_PAGE)
            .then(response => {
                setPendingBubbles(response.data.results);
                setTotalCount(response.data.totalCount);
                setCurrentPage(pageToFetch);
                setError(null);
            })
            .catch(err => {
                console.error(err);
                setError("Impossible de récupérer les propositions.");
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
            alert(`Une erreur est survenue lors de l'action.`);
            console.error(err);
        }
    };

    const handleEditClick = (bubble) => {
        setEditingBubble(bubble);
    };

    const handleEditSuccess = () => {
        setEditingBubble(null);
        fetchPending(currentPage);
    };
    
    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    if (isLoading && pendingBubbles.length === 0) return <div style={{padding:'2rem', textAlign:'center', color:'#666'}}>Chargement des propositions...</div>;
    if (error) return <div style={{padding:'1rem', color:'#ef4444', background:'#fee2e2', borderRadius:'6px'}}>{error}</div>;

    const paginationStyle = {
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '1rem',
        marginTop: '2rem',
        paddingTop: '1rem',
        borderTop: '1px solid #eee'
    };
    
    const btnStyle = {
        padding: '0.5rem 1rem',
        border: '1px solid #d1d5db',
        background: 'white',
        borderRadius: '6px',
        cursor: 'pointer',
        color: '#374151'
    };

    return (
        <div>
            <div style={{marginBottom: '1.5rem', color: '#4b5563'}}>
                <strong>{totalCount}</strong> bulle(s) en attente de votre expertise.
            </div>

            {pendingBubbles.length === 0 ? (
                <div style={{textAlign: 'center', padding: '3rem', border: '2px dashed #e5e7eb', borderRadius: '8px', color:'#9ca3af'}}>
                    <p>Tout est propre ! Aucune bulle à valider pour le moment.</p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {pendingBubbles.map(bubble => (
                        <BubbleReviewItem 
                            key={bubble.id}
                            bubble={bubble}
                            onAction={handleAction}
                            onEdit={handleEditClick}
                        />
                    ))}
                </div>
            )}
            
            {totalPages > 1 && (
                <div style={paginationStyle}>
                    <button 
                        style={{...btnStyle, opacity: currentPage === 1 ? 0.5 : 1}} 
                        onClick={() => fetchPending(currentPage - 1)} 
                        disabled={currentPage === 1}
                    >
                        &larr; Précédent
                    </button>
                    <span style={{fontSize: '0.9rem', color: '#6b7280'}}>Page {currentPage} / {totalPages}</span>
                    <button 
                        style={{...btnStyle, opacity: currentPage === totalPages ? 0.5 : 1}} 
                        onClick={() => fetchPending(currentPage + 1)} 
                        disabled={currentPage === totalPages}
                    >
                        Suivant &rarr;
                    </button>
                </div>
            )}

            <Modal 
                isOpen={!!editingBubble} 
                onClose={() => setEditingBubble(null)}
                title="Correction de la proposition"
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

export default BubbleReviewList;