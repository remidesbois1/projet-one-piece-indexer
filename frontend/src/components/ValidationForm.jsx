import React, { useState, useEffect, useRef } from 'react';
import { createBubble, updateBubbleText } from '@/lib/api';

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";


import { AlertCircle, Loader2 } from "lucide-react";

import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ValidationForm = ({ annotationData, onValidationSuccess, onCancel, onReject, isSandbox = false, tone = 'light' }) => {
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const isSubmitting = false;
  const textareaRef = useRef(null);

  const isEditing = annotationData && annotationData.id && typeof annotationData.id !== 'string';

  useEffect(() => {
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 100);
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (annotationData) {
        if (annotationData.texte_propose === '<REJET>') {
          setText('');
          setIsAiFailure(true);
        } else {
          setText(annotationData.texte_propose || '');
          setIsAiFailure(false);
        }
      }
    }, 0);
    return () => clearTimeout(timeout);
  }, [annotationData]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (text.trim() === '') {
      toast.error("Le texte ne peut pas être vide.");
      return;
    }

    const tempId = annotationData.id;
    const finalBubbleData = {
      id_page: annotationData.id_page,
      x: annotationData.x, y: annotationData.y,
      w: annotationData.w, h: annotationData.h,
      texte_propose: text,
      tempId: typeof tempId === 'string' ? tempId : null
    };

    const optimisticBubble = { ...finalBubbleData, id: tempId, isOptimistic: true };
    onValidationSuccess(optimisticBubble);

    if (isSandbox) return;

    try {
      if (isEditing) {
        const response = await updateBubbleText(annotationData.id, text);
        onValidationSuccess(response.data, tempId);
      } else {
        const response = await createBubble(finalBubbleData);
        onValidationSuccess(response.data, tempId);
      }
    } catch (error) {
      console.error("Erreur soumission background", error);
      toast.error("Erreur d'enregistrement en arrière-plan.");
    }
  };

  if (!annotationData) return null;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {isAiFailure && (
        <div className={cn(
          "rounded-md p-3 flex gap-2 text-sm",
          tone === 'dark'
            ? "border border-amber-400/30 bg-amber-400/10 text-amber-100"
            : "border border-amber-200 bg-amber-50 text-amber-800"
        )}>
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p>{"L'IA n'a pas pu lire le texte. Veuillez le transcrire manuellement."}</p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="bubble-text" className={tone === 'dark' ? "text-slate-200" : undefined}>Texte de la bulle</Label>
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
          className={cn(
            "min-h-[120px] text-base resize-y font-medium",
            tone === 'dark'
              ? "border-white/15 bg-slate-900 text-slate-50 placeholder:text-slate-500 focus-visible:border-sky-400 focus-visible:ring-sky-400/20"
              : ""
          )}
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
            className={tone === 'dark' ? "border-white/15 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white" : undefined}
          >
            Annuler
          </Button>
        )}

        <Button
          type="submit"
          disabled={isSubmitting}
          className={cn(
            "min-w-[140px] text-white",
            tone === 'dark' ? "bg-sky-600 hover:bg-sky-500" : "bg-slate-900 hover:bg-slate-800"
          )}
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
