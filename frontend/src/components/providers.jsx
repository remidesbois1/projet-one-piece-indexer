"use client";

import { AuthProvider } from '@/context/AuthContext';
import { WorkerProvider } from '@/context/WorkerContext';
import { RerankProvider } from '@/context/RerankContext';
import { DetectionProvider } from '@/context/DetectionContext';

export function Providers({ children }) {
    return (
        <AuthProvider>
            <WorkerProvider>
                <DetectionProvider>
                    <RerankProvider>
                        {children}
                    </RerankProvider>
                </DetectionProvider>
            </WorkerProvider>
        </AuthProvider>
    );
}
