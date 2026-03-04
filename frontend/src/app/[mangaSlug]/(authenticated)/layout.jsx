"use client";
import React, { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';

export default function AuthenticatedLayout({ children }) {
    const { session, loading, isGuest } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!loading && !session && !isGuest) {
            const currentUrl = encodeURIComponent(window.location.pathname + window.location.search);
            router.push(`/login?next=${currentUrl}`);
        }
    }, [session, loading, isGuest, router]);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="h-8 w-8 animate-spin border-4 border-slate-200 border-t-primary rounded-full"></div>
                    <p className="text-slate-400 text-sm font-medium">Initialisation...</p>
                </div>
            </div>
        );
    }

    if (!session && !isGuest) {
        return null;
    }

    return children;
}
