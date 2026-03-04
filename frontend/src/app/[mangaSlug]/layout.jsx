"use client";
import React, { useState, useEffect } from 'react';
import Header from '@/components/Header';
import { MangaProvider } from "@/context/MangaContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import ApiKeyForm from '@/components/ApiKeyForm';

export default function MangaLayout({ children }) {
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);

    const handleSaveApiKey = (key) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('google_api_key', key);
        }
        setShowApiKeyModal(false);
        window.dispatchEvent(new Event('storage'));
    };

    useEffect(() => {
        const handleOpenModal = () => setShowApiKeyModal(true);
        window.addEventListener('open-api-key-modal', handleOpenModal);
        return () => window.removeEventListener('open-api-key-modal', handleOpenModal);
    }, []);

    return (
        <MangaProvider>
            <Header onOpenApiKeyModal={() => setShowApiKeyModal(true)} />
            <main className="container mx-auto py-6 px-4 sm:px-8 max-w-[1600px] page-transition">
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
        </MangaProvider>
    );
}
