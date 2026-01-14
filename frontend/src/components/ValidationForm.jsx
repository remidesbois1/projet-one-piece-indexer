import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { createBubble, updateBubbleText } from '../services/api';

// UI Components
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert"; // Optionnel, sinon div simple

// Icons
import { AlertCircle, Loader2 } from "lucide-react";

const ValidationForm = ({ annotationData, onValidationSuccess, onCancel }) => {
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef(null);

  const isEditing = annotationData && annotationData.id;

  useEffect(() => {
    // Petit délai pour laisser le temps au Dialog de s'ouvrir et focus
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
      // Tu pourrais utiliser un Toast ici
      alert("Le texte ne peut pas être vide.");
      return;
    }
    setIsSubmitting(true);
    try {
      if (isEditing) {
        await updateBubbleText(annotationData.id, text, session.access_token);
      } else {
        const finalBubbleData = {
          id_page: annotationData.id_page,
          x: annotationData.x, y: annotationData.y,
          w: annotationData.w, h: annotationData.h,
          texte_propose: text,
        };
        await createBubble(finalBubbleData, session.access_token);
      }
      onValidationSuccess();
    } catch (error) {
      console.error("Erreur soumission", error);
      alert("Une erreur est survenue.");
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