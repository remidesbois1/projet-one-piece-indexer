import React, { useState, useRef, useEffect } from 'react';
import { GripHorizontal } from "lucide-react";

const DraggableWrapper = ({ children, title, onClose, className }) => {
    const [isDragging, setIsDragging] = useState(false);
    
    // On stocke le décalage (translation) courant
    const [translate, setTranslate] = useState({ x: 0, y: 0 });
    
    // On stocke la position de la souris au début du drag
    const dragStartPos = useRef({ x: 0, y: 0 });
    // On stocke la translation qu'on avait au début du drag
    const translateStart = useRef({ x: 0, y: 0 });

    const handleMouseDown = (e) => {
        if (!e.target.closest('.drag-handle')) return;
        e.preventDefault();

        setIsDragging(true);
        // On mémorise où est la souris et où était la fenêtre
        dragStartPos.current = { x: e.clientX, y: e.clientY };
        translateStart.current = { ...translate };
    };

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            
            // Delta = position souris actuelle - position souris départ
            const dx = e.clientX - dragStartPos.current.x;
            const dy = e.clientY - dragStartPos.current.y;

            // Nouvelle translation = Ancienne translation + Delta
            setTranslate({
                x: translateStart.current.x + dx,
                y: translateStart.current.y + dy
            });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    return (
        <div 
            style={{ 
                transform: `translate(${translate.x}px, ${translate.y}px)`,
                // On s'assure que le style ne passe jamais en fixed/absolute
                position: 'relative', 
                zIndex: 51,
                touchAction: 'none'
            }}
            className={`bg-white rounded-lg shadow-xl border border-slate-200 flex flex-col overflow-hidden ${className}`}
        >
            {/* Header Draggable */}
            <div 
                onMouseDown={handleMouseDown}
                className="drag-handle flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-100 cursor-grab active:cursor-grabbing select-none transition-colors hover:bg-slate-100"
            >
                <div className="flex items-center gap-2 text-slate-700 font-semibold text-sm">
                    <GripHorizontal className="h-4 w-4 text-slate-400" />
                    <span>{title}</span>
                </div>
                {onClose && (
                    <button onClick={onClose} className="text-slate-400 hover:text-red-500 text-lg leading-none px-2">
                        &times;
                    </button>
                )}
            </div>
            
            {/* Contenu */}
            <div className="p-0">
                {children}
            </div>
        </div>
    );
};

export default DraggableWrapper;