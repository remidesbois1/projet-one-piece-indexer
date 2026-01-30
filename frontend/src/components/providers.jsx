"use client";

import { AuthProvider } from '@/context/AuthContext';
import { WorkerProvider } from '@/context/WorkerContext';
import { RerankProvider } from '@/context/RerankContext';

export function Providers({ children }) {
    return (
        <AuthProvider>
            <WorkerProvider>
                <RerankProvider>
                    {children}
                </RerankProvider>
            </WorkerProvider>
        </AuthProvider>
    );
}
