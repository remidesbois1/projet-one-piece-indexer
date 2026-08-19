"use client";
import React, { useState, useEffect } from 'react';
import Header from '@/components/Header';
import { MangaProvider } from "@/context/MangaContext";
import { TauriLocalOcrProvider } from '@/context/TauriLocalOcrContext';
import { Dialog } from "@/components/ui/dialog";
import AiAccessDialog from '@/components/AiAccessDialog';

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
                <div className="poneglyph-app">
                    <section className="poneglyph-shell mx-auto flex h-screen max-w-[1600px] flex-col overflow-hidden border-x">
                        <Header onOpenApiKeyModal={() => setShowApiKeyModal(true)} />
                        <main className="page-transition flex-1 overflow-hidden px-4 py-7 sm:px-8 lg:px-10">
                            {children}
                        </main>
                    </section>
                </div>
            </TauriLocalOcrProvider>

            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <AiAccessDialog onSave={handleSaveApiKey} />
            </Dialog>
        </MangaProvider>
    );
}
