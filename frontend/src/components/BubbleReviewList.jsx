import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPendingBubbles, validateBubble, rejectBubble } from '../services/api';
import BubbleReviewItem from './BubbleReviewItem';
import ValidationForm from './ValidationForm';

// Shadcn Components
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Icons
import { CheckCircle2, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";

const RESULTS_PER_PAGE = 5;

const BubbleReviewList = () => {
    const { session } = useAuth();
    const [pendingBubbles, setPendingBubbles] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    
    // État pour l'édition (Dialog)
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
            // On recharge la liste après l'action
            fetchPending(currentPage);
        } catch (err) {
            alert(`Une erreur est survenue lors de l'action.`);
            console.error(err);
        }
    };

    const handleEditSuccess = () => {
        setEditingBubble(null);
        fetchPending(currentPage);
    };
    
    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    // --- Loading State ---
    if (isLoading && pendingBubbles.length === 0) {
        return (
            <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-40 w-full rounded-lg" />)}
            </div>
        );
    }

    // --- Error State ---
    if (error) {
        return (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg flex items-center gap-2 border border-red-100">
                <AlertCircle className="h-5 w-5" />
                {error}
            </div>
        );
    }

    return (
        <div className="space-y-6">
            
            {/* Header Info */}
            <div className="flex items-center gap-2 text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200 w-fit">
                <Badge variant="secondary" className="bg-white border-slate-200 text-slate-900">
                    {totalCount}
                </Badge>
                <span className="text-sm font-medium">bulle(s) en attente de validation</span>
            </div>

            {/* List Content */}
            {pendingBubbles.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                    <div className="flex justify-center mb-4">
                        <CheckCircle2 className="h-12 w-12 text-slate-300" />
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">Tout est propre !</h3>
                    <p className="text-slate-500">Aucune bulle à valider pour le moment.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {pendingBubbles.map(bubble => (
                        <BubbleReviewItem 
                            key={bubble.id}
                            bubble={bubble}
                            onAction={handleAction}
                            onEdit={setEditingBubble}
                        />
                    ))}
                </div>
            )}
            
            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex justify-center items-center gap-4 pt-6 mt-4 border-t border-slate-100">
                    <Button 
                        variant="outline"
                        onClick={() => fetchPending(currentPage - 1)} 
                        disabled={currentPage === 1}
                        className="w-32"
                    >
                        <ChevronLeft className="mr-2 h-4 w-4" /> Précédent
                    </Button>
                    
                    <span className="text-sm font-medium text-slate-600">
                        Page {currentPage} / {totalPages}
                    </span>
                    
                    <Button 
                        variant="outline"
                        onClick={() => fetchPending(currentPage + 1)} 
                        disabled={currentPage === totalPages}
                        className="w-32"
                    >
                        Suivant <ChevronRight className="ml-2 h-4 w-4" />
                    </Button>
                </div>
            )}

            {/* Dialog d'Édition (Remplacement du Modal) */}
            <Dialog open={!!editingBubble} onOpenChange={(open) => !open && setEditingBubble(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Correction de la proposition</DialogTitle>
                    </DialogHeader>
                    
                    {editingBubble && (
                        <ValidationForm 
                            annotationData={editingBubble} 
                            onValidationSuccess={handleEditSuccess}
                            onCancel={() => setEditingBubble(null)}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default BubbleReviewList;