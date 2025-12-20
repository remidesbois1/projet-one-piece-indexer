import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from "@/components/ui/button";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const SortableBubbleItem = ({ bubble, index, user, onEdit, onDelete, disabled }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: bubble.id, disabled: disabled });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 999 : 'auto',
        position: 'relative',
        touchAction: 'none'
    };

    return (
        <li 
            ref={setNodeRef} 
            style={style} 
            className={cn(
                // TRANSITION VERS GRID : C'est plus robuste que Flex pour l'overflow
                // grid-cols-[auto_auto_1fr_auto] : 
                // 1. Grip (auto)
                // 2. Numéro (auto)
                // 3. Texte (1fr = tout l'espace restant)
                // 4. Actions (auto)
                "group grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg shadow-sm transition-all w-full max-w-full box-border",
                isDragging && "opacity-50 border-dashed border-slate-400 bg-slate-50",
                !isDragging && "hover:border-slate-300 hover:shadow-md"
            )}
        >
            {/* 1. Poignée de drag */}
            <div 
                {...attributes} 
                {...listeners} 
                className={cn(
                    "cursor-grab text-slate-300 hover:text-slate-500 transition-colors flex-shrink-0",
                    disabled && "cursor-default opacity-50"
                )}
            >
                <GripVertical className="h-5 w-5" />
            </div>
            
            {/* 2. Numéro */}
            <span className="flex items-center justify-center h-6 w-6 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex-shrink-0">
                {index + 1}
            </span>
            
            {/* 3. Texte : min-w-0 est OBLIGATOIRE même en Grid pour que le truncate fonctionne */}
            <div className="min-w-0">
                <span 
                    className="text-sm text-slate-700 truncate font-medium block w-full" 
                    title={bubble.texte_propose}
                >
                    {bubble.texte_propose || <em className="text-slate-400">Sans texte</em>}
                </span>
            </div>

            {/* 4. Actions */}
            <div className="flex justify-end min-w-[60px]"> {/* min-w réserve la place pour éviter le saut au survol */}
                {!disabled && bubble.statut === 'Proposé' && user && bubble.id_user_createur === user.id && (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            onClick={(e) => { e.stopPropagation(); onEdit(bubble); }}
                            title="Modifier"
                        >
                            <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={(e) => { e.stopPropagation(); onDelete(bubble.id); }}
                            title="Supprimer"
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                )}
            </div>
        </li>
    );
};