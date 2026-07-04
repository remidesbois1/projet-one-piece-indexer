import React, { useState, useRef, useEffect } from 'react';
import { GripHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const DraggableWrapper = ({ children, title, onClose, className, tone = 'light', storageKey }) => {
    const [isDragging, setIsDragging] = useState(false);


    const loadInitialTranslate = () => {
        if (!storageKey) return { x: 0, y: 0 };
        try {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                    return parsed;
                }
            }
        } catch (e) {
            console.warn('DraggableWrapper: impossible de lire la position sauvegardée', e);
        }
        return { x: 0, y: 0 };
    };

    const [translate, setTranslate] = useState(loadInitialTranslate);


    const dragStartPos = useRef({ x: 0, y: 0 });

    const translateStart = useRef({ x: 0, y: 0 });

    const persistTranslate = (next) => {
        setTranslate(next);
        if (storageKey) {
            try {
                localStorage.setItem(storageKey, JSON.stringify(next));
            } catch (e) {
                console.warn('DraggableWrapper: impossible de sauvegarder la position', e);
            }
        }
    };

    const handleMouseDown = (e) => {
        if (!e.target.closest('.drag-handle')) return;
        e.preventDefault();

        setIsDragging(true);

        dragStartPos.current = { x: e.clientX, y: e.clientY };
        translateStart.current = { ...translate };
    };

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            
            
            const dx = e.clientX - dragStartPos.current.x;
            const dy = e.clientY - dragStartPos.current.y;

            
            persistTranslate({
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
                
                position: 'relative', 
                zIndex: 51,
                touchAction: 'none'
            }}
            className={cn(
                "rounded-lg shadow-2xl flex flex-col overflow-hidden",
                tone === 'dark'
                    ? "border border-white/10 bg-slate-950 text-slate-100 shadow-black/40"
                    : "border border-slate-200 bg-white text-slate-900 shadow-xl",
                className
            )}
        >
            
            <div 
                onMouseDown={handleMouseDown}
                className={cn(
                    "drag-handle flex items-center justify-between px-4 py-3 cursor-grab active:cursor-grabbing select-none transition-colors",
                    tone === 'dark'
                        ? "border-b border-white/10 bg-slate-900 hover:bg-slate-800"
                        : "border-b border-slate-100 bg-slate-50 hover:bg-slate-100"
                )}
            >
                <div className={cn(
                    "flex items-center gap-2 font-semibold text-sm",
                    tone === 'dark' ? "text-slate-100" : "text-slate-700"
                )}>
                    <GripHorizontal className={cn("h-4 w-4", tone === 'dark' ? "text-slate-500" : "text-slate-400")} />
                    <span>{title}</span>
                </div>
                {onClose && (
                    <button
                        onClick={onClose}
                        className={cn(
                            "text-lg leading-none px-2 transition-colors",
                            tone === 'dark' ? "text-slate-400 hover:text-red-300" : "text-slate-400 hover:text-red-500"
                        )}
                    >
                        &times;
                    </button>
                )}
            </div>
            
            
            <div className="p-0">
                {children}
            </div>
        </div>
    );
};

export default DraggableWrapper;
