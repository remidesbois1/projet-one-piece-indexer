"use client";
import React, { useEffect } from 'react';
import Header from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import { useRouter, usePathname } from 'next/navigation';

export default function AuthenticatedLayout({ children }) {
    const { session, loading, isGuest } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!loading && !session && !isGuest) {
            router.push('/login');
        }
    }, [session, loading, isGuest, router]);

    if (loading) {
        return <div className="flex items-center justify-center min-h-screen">Chargement...</div>;
    }

    // If not logged in and not guest, useEffect will redirect.
    // We can render null or a loader while redirecting.
    if (!session && !isGuest) {
        return null;
    }

    return (
        <>
            <Header />
            <main className="container mx-auto py-6 px-4 sm:px-8 max-w-[1600px]">
                {children}
            </main>
        </>
    );
}
