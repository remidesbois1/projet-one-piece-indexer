import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getBubbleCrop } from '@/lib/api';

// UI Components
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Icons
import { Check, X, Pencil, ImageOff, History } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getBubbleHistory } from '@/lib/api';

const BubbleReviewItem = ({ bubble, onAction, onEdit }) => {
  const { session } = useAuth();
  const [imageSrc, setImageSrc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // History State
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

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

  useEffect(() => {
    if (isHistoryOpen) {
      setLoadingHistory(true);
      getBubbleHistory(bubble.id)
        .then(res => setHistory(res.data))
        .catch(err => console.error("History fetch error:", err))
        .finally(() => setLoadingHistory(false));
    }
  }, [isHistoryOpen, bubble.id]);

  const handleActionSequence = (type) => {
    if (animStep !== 'idle') return;

    setActionType(type);
    setAnimStep('stamped');

    setTimeout(() => {
      setAnimStep('leaving');

      setTimeout(() => {
        onAction(type, bubble.id);
      }, 50);
    }, 600);
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div
      className={cn(
        "relative flex flex-col sm:flex-row bg-white border border-slate-200 rounded-lg overflow-hidden transition-all duration-500 ease-in-out mb-4 shadow-sm",
        animStep === 'leaving' && "max-h-0 mb-0 opacity-0 py-0 border-0",
        animStep === 'leaving' && actionType === 'validate' && "translate-x-[100%]",
        animStep === 'leaving' && actionType === 'reject' && "translate-y-[50px] rotate-6",
        animStep === 'idle' && "hover:shadow-md hover:border-slate-300"
      )}
    >

      {/* TAMPON (Overlay) */}
      <div className={cn(
        "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-50 border-[6px] rounded-lg px-8 py-2 text-4xl font-black uppercase tracking-widest opacity-0 scale-150 transition-all duration-300",
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
        <div className="flex justify-between items-start mb-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Proposition de texte
          </div>

          {/* History Trigger */}
          <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-slate-600 -mt-1 -mr-1">
                <History className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
              <DialogHeader>
                <DialogTitle>Historique de la bulle</DialogTitle>
              </DialogHeader>
              <ScrollArea className="flex-1 pr-4">
                {loadingHistory ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : history.length === 0 ? (
                  <div className="text-center text-slate-500 py-4">Aucun historique disponible.</div>
                ) : (
                  <div className="space-y-4">
                    {history.map((entry) => (
                      <div key={entry.id} className="text-sm border-l-2 border-slate-200 pl-3 py-1">
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-semibold text-slate-700 capitalize">{entry.action.replace('_', ' ')}</span>
                          <span className="text-xs text-slate-400">{formatDate(entry.created_at)}</span>
                        </div>
                        <div className="text-xs text-slate-500 mb-1">
                          Par {entry.user?.email || 'Inconnu'}
                        </div>
                        {entry.comment && (
                          <div className="text-xs text-orange-600 italic bg-orange-50 p-1 rounded">"{entry.comment}"</div>
                        )}
                        {entry.action === 'update_text' && entry.old_data?.texte_propose && (
                          <div className="mt-1 text-xs">
                            <div className="line-through text-slate-400">{entry.old_data.texte_propose}</div>
                            <div className="text-green-600">{entry.new_data.texte_propose}</div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </DialogContent>
          </Dialog>
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
