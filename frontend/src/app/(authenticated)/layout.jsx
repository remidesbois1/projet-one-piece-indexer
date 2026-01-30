"use client";
import React, { useEffect, useState } from 'react';
import Header from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import ApiKeyForm from '@/components/ApiKeyForm';

export default function AuthenticatedLayout({ children }) {
    const { session, loading, isGuest } = useAuth();
    const router = useRouter();
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);

    const handleSaveApiKey = (key) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('google_api_key', key);
        }
        setShowApiKeyModal(false);
        window.dispatchEvent(new Event('storage'));
    };

    useEffect(() => {
        if (!loading && !session && !isGuest) {
            router.push('/login');
        }
    }, [session, loading, isGuest, router]);

    if (loading) {
        return <div className="flex items-center justify-center min-h-screen">Chargement...</div>;
    }

    if (!session && !isGuest) {
        return null;
    }

    return (
        <>
            <Header onOpenApiKeyModal={() => setShowApiKeyModal(true)} />
            <main className="container mx-auto py-6 px-4 sm:px-8 max-w-[1600px]">
                {children}
            </main>

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API</DialogTitle>
                        <DialogDescription>
                            Gérez votre clé API Google Gemini pour l'ensemble de l'application.
                        </DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>
        </>
    );
}
