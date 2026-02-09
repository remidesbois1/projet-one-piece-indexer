import React from 'react';
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
    return (
        <div className="w-full space-y-10 animate-pulse">
            <header className="flex items-center justify-between mb-10 pb-4 border-b border-slate-100">
                <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-lg" />
                    <Skeleton className="h-8 w-48" />
                    <Skeleton className="h-5 w-24 rounded-full" />
                </div>
            </header>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 sm:gap-8">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
                    <div key={i} className="flex flex-col gap-3">
                        <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                        <div className="space-y-2">
                            <Skeleton className="h-4 w-20" />
                            <Skeleton className="h-6 w-12" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
