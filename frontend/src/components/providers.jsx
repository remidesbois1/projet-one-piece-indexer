"use client";

import { AuthProvider } from '@/context/AuthContext';
import { WorkerProvider } from '@/context/WorkerContext';

export function Providers({ children }) {
    return (
        <AuthProvider>
            <WorkerProvider>
                {children}
            </WorkerProvider>
        </AuthProvider>
    );
}
