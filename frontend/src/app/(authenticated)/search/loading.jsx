import React from 'react';
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
    return (
        <div className="min-h-screen pb-20 space-y-8">
            {/* Hero Search Area Skeleton */}
            <div className="bg-white border-b border-slate-200 pt-10 pb-8 px-4 shadow-sm -mx-4 sm:-mx-8 mb-8">
                <div className="container max-w-4xl mx-auto text-center space-y-6">
                    <Skeleton className="h-10 w-2/3 mx-auto" />
                    <Skeleton className="h-14 w-full max-w-2xl mx-auto rounded-full" />
                    <div className="flex justify-center gap-4">
                        <Skeleton className="h-8 w-40 rounded-full" />
                        <Skeleton className="h-8 w-40 rounded-full" />
                    </div>
                </div>
            </div>

            <div className="container mx-auto px-4 max-w-7xl">
                <div className="flex items-center justify-between mb-6">
                    <Skeleton className="h-8 w-48" />
                    <Skeleton className="h-8 w-32" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                        <div key={i} className="rounded-lg border border-slate-200 bg-white overflow-hidden flex flex-col h-[400px]">
                            <Skeleton className="h-56 w-full" />
                            <div className="p-5 flex-1 space-y-4">
                                <div className="flex gap-2">
                                    <Skeleton className="h-4 w-16" />
                                    <Skeleton className="h-4 w-16" />
                                </div>
                                <Skeleton className="h-16 w-full" />
                                <div className="flex justify-between items-center pt-4">
                                    <Skeleton className="h-4 w-24" />
                                    <Skeleton className="h-5 w-10" />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
