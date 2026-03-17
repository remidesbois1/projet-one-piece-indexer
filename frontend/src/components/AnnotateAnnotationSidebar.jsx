import React from 'react';
import { 
    DndContext, 
    closestCenter 
} from '@dnd-kit/core';
import { 
    SortableContext, 
    verticalListSortingStrategy 
} from '@dnd-kit/sortable';
import { SortableBubbleItem } from '@/components/SortableBubbleItem';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { MousePointer2 } from "lucide-react";

export default function AnnotateAnnotationSidebar({
    existingBubbles,
    handleDragEnd,
    user,
    handleEditBubble,
    handleDeleteBubble,
    canEdit
}) {
    return (
        <aside className="w-full lg:w-[380px] bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col h-[40vh] lg:h-full overflow-hidden z-10 shadow-lg shrink-0">
            <div className="flex-none p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <h3 className="font-semibold text-slate-900">Annotations</h3>
                <Badge variant="secondary">{existingBubbles.length}</Badge>
            </div>
            <ScrollArea className="flex-1 w-full h-full">
                <div className="flex flex-col w-full max-w-full px-4 py-4 pb-20 overflow-x-hidden">
                    {existingBubbles.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-10 text-center border-2 border-dashed border-slate-200 rounded-lg bg-slate-50/50 text-slate-500">
                            <MousePointer2 className="h-8 w-8 mb-2 text-slate-300" />
                            <p className="text-sm font-medium">Aucune annotation</p>
                            <p className="text-xs mt-1">Dessinez un rectangle sur l'image<br />pour commencer.</p>
                        </div>
                    ) : (
                        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                            <SortableContext items={existingBubbles.map(b => b.id)} strategy={verticalListSortingStrategy}>
                                <ul className="flex flex-col gap-3 w-full max-w-full">
                                    {existingBubbles.map((bubble, index) => (
                                        <SortableBubbleItem
                                            key={bubble.id}
                                            id={bubble.id}
                                            bubble={bubble}
                                            index={index}
                                            user={user}
                                            onEdit={handleEditBubble}
                                            onDelete={handleDeleteBubble}
                                            disabled={!canEdit}
                                        />
                                    ))}
                                </ul>
                            </SortableContext>
                        </DndContext>
                    )}
                </div>
            </ScrollArea>
        </aside>
    );
}
