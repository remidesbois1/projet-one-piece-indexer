"use client";

import React, { Suspense } from 'react';
import { DetectionProvider } from '@/context/DetectionContext';
import BatchOcrManager from '@/components/BatchOcrManager';

function PageSkeleton() {
    return (
        <div className="container max-w-5xl mx-auto py-10 px-4">
            <div className="flex items-center justify-center min-h-[50vh]">
                <div className="h-8 w-8 animate-spin border-2 border-slate-200 border-t-indigo-600 rounded-full" />
            </div>
        </div>
    );
}

export default function BatchOcrPage() {
    return (
        <Suspense fallback={<PageSkeleton />}>
            <DetectionProvider>
                <BatchOcrManager />
            </DetectionProvider>
        </Suspense>
    );
}
