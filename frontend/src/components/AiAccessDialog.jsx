"use client";

import { Sparkles } from 'lucide-react';

import ApiKeyForm from '@/components/ApiKeyForm';
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function AiAccessDialog({ onSave }) {
    return (
        <DialogContent className="max-h-[88vh] gap-0 overflow-hidden border-white/10 bg-[#071624] p-0 text-slate-100 shadow-2xl shadow-black/60 sm:max-w-xl [&_[data-slot=dialog-close]]:text-slate-400 [&_[data-slot=dialog-close]]:hover:bg-white/10 [&_[data-slot=dialog-close]]:hover:text-white">
            <DialogHeader className="border-b border-white/10 bg-gradient-to-br from-indigo-500/15 via-transparent to-sky-400/10 px-6 py-5 pr-14 text-left">
                <div className="flex items-center gap-3">
                    <span className="rounded-xl border border-indigo-400/20 bg-indigo-400/10 p-2.5 shadow-inner"><Sparkles className="h-5 w-5 text-indigo-200" /></span>
                    <div>
                        <DialogTitle className="text-lg text-white">Accès aux services IA</DialogTitle>
                        <DialogDescription className="mt-1 text-xs leading-relaxed text-slate-400">Gérez votre clé Gemini et votre connexion ChatGPT Desktop.</DialogDescription>
                    </div>
                </div>
            </DialogHeader>
            <div className="overflow-y-auto px-5 py-5 sm:px-6"><ApiKeyForm onSave={onSave} /></div>
        </DialogContent>
    );
}
