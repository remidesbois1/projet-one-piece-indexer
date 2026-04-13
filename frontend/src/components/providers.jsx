"use client";

import { AuthProvider } from '@/context/AuthContext';
import { WorkerProvider } from '@/context/WorkerContext';
import { DetectionProvider } from '@/context/DetectionContext';

export function Providers({ children }) {
    return (
        <AuthProvider>
            <WorkerProvider>
                <DetectionProvider>
                    {children}
                </DetectionProvider>
            </WorkerProvider>
        </AuthProvider>
    );
}
