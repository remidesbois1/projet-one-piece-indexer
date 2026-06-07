"use client";
import React, { useState, useEffect } from 'react';
import Header from '@/components/Header';
import { MangaProvider } from "@/context/MangaContext";
import { TauriLocalOcrProvider } from '@/context/TauriLocalOcrContext';
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
            <TauriLocalOcrProvider>
                <div className="min-h-screen bg-[#f6fbff] bg-[image:url('/bg.webp')] bg-cover bg-center bg-fixed text-[#07133c]">
                    <section className="mx-auto min-h-screen max-w-[1600px] overflow-hidden border-x border-[#c8dcf2] bg-white/62 shadow-[0_24px_70px_rgba(32,76,121,0.20)] backdrop-blur-md">
                        <Header onOpenApiKeyModal={() => setShowApiKeyModal(true)} />
                        <main className="page-transition px-4 py-7 sm:px-8 lg:px-10">
                            {children}
                        </main>
                    </section>
                </div>
            </TauriLocalOcrProvider>

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API</DialogTitle>
                        <DialogDescription>
                            Gérez votre clé API pour l&apos;ensemble de l&apos;application.
                        </DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>
        </MangaProvider>
    );
}
