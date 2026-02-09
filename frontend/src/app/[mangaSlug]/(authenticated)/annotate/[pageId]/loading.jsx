import React from 'react';
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
    return (
        <div className="flex flex-col h-[calc(100vh-140px)] bg-slate-50 -mt-6 -mx-4 sm:-mx-8">
            {/* Header Skeleton */}
            <div className="flex-none h-16 border-b border-slate-200 bg-white px-6 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-4">
                    <Skeleton className="h-8 w-24" />
                    <div className="h-6 w-px bg-slate-200" />
                    <div className="space-y-1">
                        <Skeleton className="h-5 w-32" />
                        <Skeleton className="h-3 w-16" />
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-40 rounded-lg" />
                </div>
            </div>

            {/* Main Content Skeleton */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left Side: Image Area */}
                <div className="flex-1 bg-slate-200/50 flex justify-center p-8">
                    <Skeleton className="w-full max-w-[800px] h-full shadow-xl rounded-sm" />
                </div>

                {/* Right Side: Sidebar Area */}
                <div className="w-[450px] border-l border-slate-200 bg-white flex flex-col p-6 space-y-6">
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-40" />
                        <Skeleton className="h-32 w-full rounded-xl" />
                    </div>
                    <div className="space-y-4">
                        <div className="flex justify-between">
                            <Skeleton className="h-10 w-24" />
                            <Skeleton className="h-10 w-24" />
                        </div>
                        <Skeleton className="h-12 w-full" />
                    </div>
                    <div className="flex-1 space-y-3">
                        <Skeleton className="h-20 w-full" />
                        <Skeleton className="h-20 w-full" />
                        <Skeleton className="h-20 w-full" />
                    </div>
                </div>
            </div>
        </div>
    );
}
