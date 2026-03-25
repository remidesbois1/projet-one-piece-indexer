import React from 'react';
import { cn } from "@/lib/utils";
import { Loader2, MousePointer2 } from "lucide-react";
import { toast } from "sonner";

export default function AnnotateCanvas({
    canEdit,
    imageDimensions,
    setImageDimensions,
    containerRef,
    imageRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    imageUrl,
    isSubmitting,
    loadingText,
    rectangle,
    pendingAnnotation,
    isAutoDetecting,
    isShiftPressed,
    handleInteractionStart,
    setIsModalOpen,
    isDrawing,
    startPoint,
    endPoint,
    existingBubbles,
    setHoveredBubble,
    hoveredBubble,
    mousePos,
    handleEditBubble
}) {
    return (
        <main className="flex-1 min-h-0 bg-slate-200/50 overflow-hidden flex items-center justify-center p-2 sm:p-4 relative cursor-default">
            <div
                ref={containerRef}
                className={cn(
                    "relative inline-flex flex-col min-w-0 min-h-0 max-w-full max-h-full bg-white shadow-xl select-none",
                    canEdit ? "cursor-crosshair" : "cursor-default"
                )}
                style={{
                    aspectRatio: imageDimensions?.naturalWidth ? `${imageDimensions.naturalWidth} / ${imageDimensions.naturalHeight}` : 'auto'
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                <img
                    ref={imageRef}
                    src={imageUrl}
                    crossOrigin="anonymous"
                    alt="Manga Page"
                    className="block w-full h-full object-contain pointer-events-none"
                    onLoad={(e) => setImageDimensions({
                        width: e.currentTarget.offsetWidth,
                        naturalWidth: e.currentTarget.naturalWidth,
                        naturalHeight: e.currentTarget.naturalHeight
                    })}
                />

                {isSubmitting && (
                    <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-50 flex flex-col items-center justify-center text-slate-800 font-semibold">
                        <Loader2 className="h-10 w-10 animate-spin mb-2 text-slate-900" />
                        <span>{loadingText}</span>
                    </div>
                )}

                {((rectangle && imageDimensions) || (pendingAnnotation && imageDimensions)) && (
                    <div
                        style={{
                            left: (pendingAnnotation?.x || rectangle.x) * (imageDimensions.width / imageDimensions.naturalWidth),
                            top: (pendingAnnotation?.y || rectangle.y) * (imageDimensions.width / imageDimensions.naturalWidth),
                            width: (pendingAnnotation?.w || rectangle.w) * (imageDimensions.width / imageDimensions.naturalWidth),
                            height: (pendingAnnotation?.h || rectangle.h) * (imageDimensions.width / imageDimensions.naturalWidth),
                        }}
                        className={cn(
                            "absolute border-2 border-dashed transition-all duration-300 z-30",
                            isAutoDetecting ? "border-indigo-500 bg-indigo-500/10" : "border-red-500 bg-red-500/10",
                            pendingAnnotation && isShiftPressed && "cursor-move"
                        )}
                        onMouseDown={(e) => {
                            if (pendingAnnotation && isShiftPressed) {
                                handleInteractionStart(e, 'move');
                            }
                        }}
                        onClick={(e) => {
                            if (isShiftPressed) return;
                            e.stopPropagation();
                            setIsModalOpen(true);
                        }}
                    >
                    </div>
                )}

                {isDrawing && startPoint && endPoint && (
                    <div
                        style={{
                            left: Math.min(startPoint.x, endPoint.x),
                            top: Math.min(startPoint.y, endPoint.y),
                            width: Math.abs(startPoint.x - endPoint.x),
                            height: Math.abs(startPoint.y - endPoint.y),
                        }}
                        className="absolute border-2 border-dashed border-red-500 bg-red-500/10 pointer-events-none z-20"
                    />
                )}

                {imageDimensions && existingBubbles.map((bubble, index) => {
                    const scale = imageDimensions.width / imageDimensions.naturalWidth;
                    if (!scale) return null;

                    if (pendingAnnotation?.id === bubble.id) return null;

                    const style = {
                        left: `${bubble.x * scale}px`,
                        top: `${bubble.y * scale}px`,
                        width: `${bubble.w * scale}px`,
                        height: `${bubble.h * scale}px`,
                    };

                    const colorClass = bubble.statut === 'Validé'
                        ? "border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20"
                        : "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20";

                    return (
                        <div
                            key={bubble.id}
                            style={style}
                            className={cn(
                                "absolute border-2 z-10 transition-colors cursor-pointer group",
                                colorClass,
                                canEdit && isShiftPressed && "cursor-move"
                            )}
                            onMouseEnter={() => setHoveredBubble(bubble)}
                            onMouseLeave={() => setHoveredBubble(null)}
                            onMouseDown={(e) => {
                                if (isShiftPressed) {
                                    handleInteractionStart(e, 'move', null, bubble);
                                }
                            }}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (isShiftPressed) return;
                                if (canEdit) {
                                    handleEditBubble(bubble);
                                } else {
                                    navigator.clipboard.writeText(bubble.texte_propose || "");
                                    toast.success("Texte copié !");
                                }
                            }}
                        >
                            <div className={cn(
                                "absolute -top-6 -left-[2px] text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm",
                                bubble.statut === 'Validé' ? "bg-emerald-500" : "bg-amber-500"
                            )}>
                                #{index + 1}
                            </div>

                            {canEdit && isShiftPressed && (
                                <>
                                    {[
                                        { h: 'nw', c: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize' },
                                        { h: 'n', c: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' },
                                        { h: 'ne', c: 'top-0 left-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize' },
                                        { h: 'w', c: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
                                        { h: 'e', c: 'top-1/2 left-full -translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
                                        { h: 'sw', c: 'top-full left-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize' },
                                        { h: 's', c: 'top-full left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' },
                                        { h: 'se', c: 'top-full left-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize' },
                                    ].map((handle) => (
                                        <div
                                            key={handle.h}
                                            className={cn(
                                                "absolute w-2.5 h-2.5 bg-white border border-slate-900 rounded-full shadow-sm z-50 hover:scale-125 transition-transform",
                                                handle.c
                                            )}
                                            onMouseDown={(e) => handleInteractionStart(e, 'resize', handle.h, bubble)}
                                        />
                                    ))}
                                </>
                            )}
                        </div>
                    );

                })}

                {hoveredBubble && (
                    <div
                        className="fixed z-50 pointer-events-none bg-slate-900/95 text-white p-3 rounded-lg shadow-xl border border-slate-700 backdrop-blur-sm max-w-[300px]"
                        style={{
                            left: 0, top: 0,
                            transform: `translate(${(mousePos.x + 20 + (containerRef.current?.getBoundingClientRect()?.left || 0))}px, ${(mousePos.y + 20 + (containerRef.current?.getBoundingClientRect()?.top || 0))}px)`
                        }}
                    >
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                            Bulle #{existingBubbles.findIndex(b => b.id === hoveredBubble.id) + 1}
                        </div>
                        <p className="text-sm font-medium leading-relaxed">{hoveredBubble.texte_propose}</p>
                    </div>
                )}
            </div>
        </main>
    );
}
