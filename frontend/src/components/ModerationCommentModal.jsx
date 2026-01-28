import React, { useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, MessageSquare } from "lucide-react";

const ModerationCommentModal = ({ isOpen, onClose, onSubmit, title, description, placeholder }) => {
    const [comment, setComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async () => {
        if (!comment.trim()) {
            alert("Veuillez laisser un commentaire pour expliquer le refus.");
            return;
        }
        setIsSubmitting(true);
        try {
            await onSubmit(comment);
            setComment('');
            onClose();
        } catch (error) {
            console.error("Erreur lors de la soumission du commentaire:", error);
            alert("Une erreur est survenue.");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && !isSubmitting && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <MessageSquare className="h-5 w-5 text-red-500" />
                        {title || "Motif du refus"}
                    </DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                    {description && (
                        <p className="text-sm text-slate-500">
                            {description}
                        </p>
                    )}
                    <div className="space-y-2">
                        <Label htmlFor="moderation-comment">Votre commentaire</Label>
                        <Textarea
                            id="moderation-comment"
                            placeholder={placeholder || "Expliquez ici ce qui ne va pas (ex: erreur de traduction, bulle mal placée...)"}
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            className="min-h-[120px] resize-none"
                            autoFocus
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        disabled={isSubmitting}
                    >
                        Annuler
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={handleSubmit}
                        disabled={isSubmitting || !comment.trim()}
                        className="min-w-[100px]"
                    >
                        {isSubmitting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            "Confirmer le refus"
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default ModerationCommentModal;
