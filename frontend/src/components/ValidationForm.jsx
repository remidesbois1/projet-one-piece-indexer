import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { createBubble, updateBubbleText } from '@/lib/api';

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Icons
import { AlertCircle, Loader2 } from "lucide-react";

import { toast } from "sonner";

const ValidationForm = ({ annotationData, onValidationSuccess, onCancel, onReject }) => {
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef(null);

  const isEditing = annotationData && annotationData.id;

  useEffect(() => {
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 100);
  }, []);

  useEffect(() => {
    if (annotationData) {
      if (annotationData.texte_propose === '<REJET>') {
        setText('');
        setIsAiFailure(true);
      } else {
        setText(annotationData.texte_propose || '');
        setIsAiFailure(false);
      }
    }
  }, [annotationData]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (text.trim() === '') {
      toast.error("Le texte ne peut pas être vide.");
      return;
    }
    setIsSubmitting(true);
    try {
      if (isEditing) {
        onValidationSuccess({ id: annotationData.id, texte_propose: text });
        await updateBubbleText(annotationData.id, text);
      } else {
        const finalBubbleData = {
          id_page: annotationData.id_page,
          x: annotationData.x, y: annotationData.y,
          w: annotationData.w, h: annotationData.h,
          texte_propose: text,
        };
        const response = await createBubble(finalBubbleData);
        onValidationSuccess(response.data);
      }
    } catch (error) {
      console.error("Erreur soumission", error);
      toast.error("Une erreur est survenue lors de l'enregistrement.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!annotationData) return null;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {isAiFailure && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3 flex gap-2 text-sm text-amber-800">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p>L'IA n'a pas pu lire le texte. Veuillez le transcrire manuellement.</p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="bubble-text">Texte de la bulle</Label>
        <Textarea
          id="bubble-text"
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          placeholder="Saisissez le texte ici..."
          className="min-h-[120px] text-base resize-y font-medium"
        />
      </div>

      <div className="flex justify-end gap-3 pt-2">
        {onReject && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => onReject(annotationData.id)}
            disabled={isSubmitting}
          >
            Refuser
          </Button>
        )}

        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Annuler
          </Button>
        )}

        <Button
          type="submit"
          disabled={isSubmitting}
          className="bg-slate-900 hover:bg-slate-800 text-white min-w-[140px]"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Enregistrement...
            </>
          ) : (
            isEditing ? 'Mettre à jour' : 'Valider'
          )}
        </Button>
      </div>
    </form>
  );
};

export default ValidationForm;