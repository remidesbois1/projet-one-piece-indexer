"use client";

import { useUserProfile } from '@/hooks/useUserProfile';
import { useAuth } from '@/context/AuthContext';
import { useRouter, useParams } from 'next/navigation';
import { useEffect } from 'react';

export default function AdminLayout({ children }) {
    const { profile, loading } = useUserProfile();
    const { isGuest } = useAuth();
    const router = useRouter();
    const params = useParams();

    useEffect(() => {
        if (!loading) {
            if (isGuest || profile?.role !== 'Admin') {
                router.push(`/${params.mangaSlug}/dashboard`);
            }
        }
    }, [loading, profile, isGuest, router, params.mangaSlug]);

    if (loading) {
        return (
            <div className="flex justify-center items-center min-h-[50vh]">
                <div className="h-8 w-8 animate-spin border-4 border-slate-200 border-t-primary rounded-full"></div>
            </div>
        );
    }

    if (isGuest || profile?.role !== 'Admin') {
        return null;
    }

    return <>{children}</>;
}
