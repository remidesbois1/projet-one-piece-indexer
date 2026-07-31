import React from 'react';
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export function measureRenderedImage(imageElement) {
    if (!imageElement?.naturalWidth || !imageElement?.naturalHeight) return null;
    const bounds = imageElement.getBoundingClientRect?.();
    const width = bounds?.width || imageElement.offsetWidth;
    const height = bounds?.height || imageElement.offsetHeight;
    if (!width || !height) return null;
    return {
        width,
        height,
        naturalWidth: imageElement.naturalWidth,
        naturalHeight: imageElement.naturalHeight,
    };
}

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
    handleEditBubble,
    detectionDebugEnabled = false,
    detectionDebugData = null
}) {
    React.useEffect(() => {
        const imageElement = imageRef.current;
        if (!imageElement) return undefined;

        const updateDimensions = () => {
            const dimensions = measureRenderedImage(imageElement);
            if (dimensions) setImageDimensions(dimensions);
        };
        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(updateDimensions)
            : null;
        observer?.observe(imageElement);
        imageElement.addEventListener('load', updateDimensions);
        if (imageElement.complete) updateDimensions();

        return () => {
            observer?.disconnect();
            imageElement.removeEventListener('load', updateDimensions);
        };
    }, [imageRef, imageUrl, setImageDimensions]);

    const debugScale = imageDimensions?.width && imageDimensions?.naturalWidth
        ? imageDimensions.width / imageDimensions.naturalWidth
        : 0;
    const toDebugStyle = (box) => {
        if (!debugScale || !box) return null;
        return {
            left: `${box.x * debugScale}px`,
            top: `${box.y * debugScale}px`,
            width: `${box.w * debugScale}px`,
            height: `${box.h * debugScale}px`,
        };
    };

    return (
        <main className="relative flex min-h-0 flex-1 cursor-default items-center justify-center overflow-hidden bg-[#020812]/82 p-2 sm:p-4">
            <div
                ref={containerRef}
                className={cn(
                    "relative inline-flex min-h-0 min-w-0 max-h-full max-w-full select-none flex-col bg-[#040d18] shadow-xl",
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
                    onLoad={(event) => {
                        const dimensions = measureRenderedImage(event.currentTarget);
                        if (dimensions) setImageDimensions(dimensions);
                    }}
                />

                {isSubmitting && (
                    <div className="pointer-events-none absolute inset-x-0 top-4 z-50 flex justify-center px-4">
                        <div className="flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-md border border-white/10 bg-[#06111e]/92 px-3 py-2 text-xs font-semibold text-slate-100 shadow-lg">
                            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#8dbbff]" />
                            <span className="truncate">{loadingText}</span>
                        </div>
                    </div>
                )}

                {((rectangle && imageDimensions?.width > 0) || (pendingAnnotation && imageDimensions?.width > 0)) && (
                    <div
                        style={{
                            left: (pendingAnnotation ? pendingAnnotation.x : rectangle.x) * (imageDimensions.width / imageDimensions.naturalWidth),
                            top: (pendingAnnotation ? pendingAnnotation.y : rectangle.y) * (imageDimensions.width / imageDimensions.naturalWidth),
                            width: (pendingAnnotation ? pendingAnnotation.w : rectangle.w) * (imageDimensions.width / imageDimensions.naturalWidth),
                            height: (pendingAnnotation ? pendingAnnotation.h : rectangle.h) * (imageDimensions.width / imageDimensions.naturalWidth),
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

                {detectionDebugEnabled && imageDimensions && (
                    <div className="pointer-events-none absolute inset-0 z-40">
                        <div className="absolute left-2 top-2 max-w-[calc(100%-1rem)] rounded-md border border-cyan-300/40 bg-slate-950/80 px-2.5 py-2 text-[11px] font-semibold leading-tight text-cyan-50 shadow-lg backdrop-blur-sm">
                            <div>debug detection</div>
                            {detectionDebugData ? (
                                <div className="mt-1 space-y-0.5 text-cyan-100/90">
                                    <div>mode: {detectionDebugData.mode}</div>
                                    <div>panels: {detectionDebugData.panelCount} · bulles: {detectionDebugData.bubbleCount}</div>
                                    <div>seuil bulle: {detectionDebugData.bubbleThreshold}</div>
                                </div>
                            ) : (
                                <div className="mt-1 text-cyan-100/80">lance une detection auto</div>
                            )}
                        </div>

                        {detectionDebugData?.panels?.map((panel) => {
                            const style = toDebugStyle(panel.box);
                            if (!style) return null;
                            return (
                                <div
                                    key={`debug-panel-${panel.order}-${panel.id}`}
                                    style={style}
                                    className="absolute border-2 border-cyan-300/90 bg-cyan-300/5 shadow-[0_0_0_1px_rgba(8,47,73,0.75)]"
                                >
                                    <div className="absolute -left-[2px] -top-6 rounded-sm bg-cyan-300 px-1.5 py-0.5 text-[10px] font-black text-slate-950 shadow-sm">
                                        P{panel.order} {panel.score != null ? `· ${panel.score}` : ''}
                                    </div>
                                </div>
                            );
                        })}

                        {detectionDebugData?.bubbles?.map((bubble) => {
                            const style = toDebugStyle(bubble.box);
                            if (!style) return null;
                            return (
                                <div
                                    key={`debug-bubble-${bubble.order}-${bubble.rawIndex}`}
                                    style={style}
                                    className="absolute border border-fuchsia-300/90 bg-fuchsia-500/10"
                                >
                                    <div className="absolute -right-[2px] -top-5 rounded-sm bg-fuchsia-500 px-1 py-0.5 text-[10px] font-black text-white shadow-sm">
                                        #{bubble.order}{bubble.panelOrder ? ` P${bubble.panelOrder}` : ' P?'}
                                    </div>
                                    <div className="absolute -bottom-5 left-0 max-w-[160px] truncate rounded-sm bg-slate-950/85 px-1 py-0.5 text-[9px] font-semibold text-fuchsia-50">
                                        raw {bubble.rawIndex}
                                        {bubble.localOrder ? ` · local ${bubble.localOrder}` : ''}
                                        {bubble.assignmentReason ? ` · ${bubble.assignmentReason}` : ''}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
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
                        className="absolute z-50 pointer-events-none bg-slate-900/95 text-white p-3 rounded-lg shadow-xl border border-slate-700 backdrop-blur-sm max-w-[300px]"
                        style={{
                            left: 0, top: 0,
                            transform: `translate(${mousePos.x + 20}px, ${mousePos.y + 20}px)`
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
