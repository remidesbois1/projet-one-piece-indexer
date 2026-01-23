import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getBubbleCrop } from '@/lib/api';

// UI Components
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Icons
import { Check, X, Pencil, ImageOff } from "lucide-react";

const BubbleReviewItem = ({ bubble, onAction, onEdit }) => {
  const { session } = useAuth();
  const [imageSrc, setImageSrc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // États d'animation : 'idle' -> 'stamped' -> 'leaving'
  const [animStep, setAnimStep] = useState('idle');
  const [actionType, setActionType] = useState(null); // 'validate' ou 'reject'

  useEffect(() => {
    let isMounted = true;

    if (session) {
      setIsLoading(true);
      getBubbleCrop(bubble.id)
        .then(response => {
          if (isMounted) {
            const localUrl = URL.createObjectURL(response.data);
            setImageSrc(localUrl);
          }
        })
        .catch(err => console.error("Erreur image crop", err))
        .finally(() => {
          if (isMounted) setIsLoading(false);
        });
    }

    return () => {
      isMounted = false;
      if (imageSrc) URL.revokeObjectURL(imageSrc);
    };
  }, [bubble.id, session]);

  const handleActionSequence = (type) => {
    if (animStep !== 'idle') return;

    setActionType(type);
    setAnimStep('stamped'); // 1. Affiche le tampon

    // 2. Attend 600ms que l'utilisateur voit le tampon, puis lance la sortie
    setTimeout(() => {
      setAnimStep('leaving');

      // 3. Attend la fin de l'animation de sortie (500ms) pour notifier le parent
      setTimeout(() => {
        onAction(type, bubble.id);
      }, 500);
    }, 600);
  };

  return (
    <div
      className={cn(
        "relative flex flex-col sm:flex-row bg-white border border-slate-200 rounded-lg overflow-hidden transition-all duration-500 ease-in-out mb-4 shadow-sm",
        // ÉTAPE 3 : La carte disparait
        animStep === 'leaving' && actionType === 'validate' && "translate-x-[100%] opacity-0 h-0 my-0 py-0",
        animStep === 'leaving' && actionType === 'reject' && "translate-y-[50px] rotate-6 opacity-0 h-0 my-0 py-0",
        animStep === 'idle' && "hover:shadow-md hover:border-slate-300"
      )}
    >

      {/* TAMPON (Overlay) */}
      <div className={cn(
        "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-50 border-[6px] rounded-lg px-8 py-2 text-4xl font-black uppercase tracking-widest opacity-0 scale-150 transition-all duration-300",
        // ÉTAPE 2 : Le tampon apparait
        animStep !== 'idle' && actionType === 'validate' && "opacity-90 scale-100 rotate-[-10deg] border-green-600 text-green-600 bg-white/50 backdrop-blur-sm",
        animStep !== 'idle' && actionType === 'reject' && "opacity-90 scale-100 rotate-[10deg] border-red-600 text-red-600 bg-white/50 backdrop-blur-sm"
      )}>
        {actionType === 'validate' ? 'VALIDÉ' : 'REJETÉ'}
      </div>

      {/* Colonne Image */}
      <div className="w-full sm:w-[200px] bg-slate-50 border-b sm:border-b-0 sm:border-r border-slate-100 flex items-center justify-center p-4 shrink-0">
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded" />
        ) : imageSrc ? (
          <img
            src={imageSrc}
            alt="Contexte"
            className="max-w-full max-h-[120px] object-contain rounded shadow-sm bg-white"
          />
        ) : (
          <div className="flex flex-col items-center text-slate-300 text-xs">
            <ImageOff className="h-8 w-8 mb-1" />
            <span>Image indisponible</span>
          </div>
        )}
      </div>

      {/* Colonne Contenu */}
      <div className="flex-1 p-5 flex flex-col justify-center">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
          Proposition de texte
        </div>
        <div className="bg-slate-50/80 p-3 rounded-md border border-slate-100 text-slate-800 text-base leading-relaxed font-medium font-sans">
          {bubble.texte_propose}
        </div>
      </div>

      {/* Colonne Actions */}
      <div className="flex sm:flex-col items-center justify-center gap-2 p-4 bg-slate-50/50 border-t sm:border-t-0 sm:border-l border-slate-100 min-w-[140px]">

        <Button
          variant="outline"
          size="sm"
          onClick={() => onEdit(bubble)}
          disabled={animStep !== 'idle'}
          className="w-full text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200 hover:border-blue-300"
        >
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Éditer
        </Button>

        <div className="hidden sm:block w-full h-px bg-slate-200 my-1"></div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => handleActionSequence('validate')}
          disabled={animStep !== 'idle'}
          className="w-full text-green-600 hover:text-green-700 hover:bg-green-50 border-green-200 hover:border-green-300"
        >
          <Check className="mr-2 h-4 w-4" />
          Valider
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => handleActionSequence('reject')}
          disabled={animStep !== 'idle'}
          className="w-full text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 hover:border-red-300"
        >
          <X className="mr-2 h-4 w-4" />
          Rejeter
        </Button>
      </div>
    </div>
  );
};

export default BubbleReviewItem;