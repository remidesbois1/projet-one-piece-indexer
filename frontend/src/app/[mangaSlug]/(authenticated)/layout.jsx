"use client";
import React, { useEffect } from 'react';
import { AUTH_STATUS, useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';

export default function AuthenticatedLayout({ children }) {
    const { authStatus, loading, error, retry } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (authStatus === AUTH_STATUS.UNAUTHENTICATED) {
            const currentUrl = encodeURIComponent(window.location.pathname + window.location.search);
            router.push(`/login?next=${currentUrl}`);
        }
    }, [authStatus, router]);

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

    if (authStatus === AUTH_STATUS.ERROR) {
        return (
            <div className="flex min-h-[60vh] items-center justify-center px-4" role="alert">
                <div className="max-w-md rounded-2xl border border-red-400/25 bg-red-950/20 p-6 text-center">
                    <h2 className="text-lg font-bold text-white">Connexion indisponible</h2>
                    <p className="mt-2 text-sm text-slate-300">
                        {error?.message || 'Impossible de vérifier votre session.'}
                    </p>
                    <button
                        type="button"
                        onClick={() => void retry()}
                        className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
                    >
                        Réessayer
                    </button>
                </div>
            </div>
        );
    }

    if (authStatus !== AUTH_STATUS.AUTHENTICATED && authStatus !== AUTH_STATUS.GUEST) {
        return null;
    }

    return children;
}
