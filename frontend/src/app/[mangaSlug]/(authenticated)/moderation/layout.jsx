"use client";

import { useUserProfile } from '@/hooks/useUserProfile';
import { AUTH_STATUS, useAuth } from '@/context/AuthContext';
import { useRouter, useParams } from 'next/navigation';
import { useEffect } from 'react';

export default function ModerationLayout({ children }) {
    const { profile, loading, error, retry } = useUserProfile();
    const { authStatus, isGuest } = useAuth();
    const router = useRouter();
    const params = useParams();

    useEffect(() => {
        const accessResolved = isGuest || authStatus === AUTH_STATUS.AUTHENTICATED;
        if (!loading && !error && accessResolved) {
            const hasAccess = !isGuest && (profile?.role === 'Admin' || profile?.role === 'Modo');
            if (!hasAccess) {
                router.push(`/${params.mangaSlug}/dashboard`);
            }
        }
    }, [authStatus, loading, error, profile, isGuest, router, params.mangaSlug]);

    if (loading) {
        return (
            <div className="flex justify-center items-center min-h-[50vh]">
                <div className="h-8 w-8 animate-spin border-4 border-slate-200 border-t-primary rounded-full"></div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center px-4" role="alert">
                <div className="max-w-md rounded-2xl border border-red-400/25 bg-red-950/20 p-6 text-center">
                    <h2 className="text-lg font-bold text-white">Permissions indisponibles</h2>
                    <p className="mt-2 text-sm text-slate-300">{error.message}</p>
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

    const hasAccess = authStatus === AUTH_STATUS.AUTHENTICATED
        && !isGuest
        && (profile?.role === 'Admin' || profile?.role === 'Modo');
    if (!hasAccess) {
        return null;
    }

    return <>{children}</>;
}
