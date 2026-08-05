"use client";

import { AlertCircle, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function MangaRouteError({ error, reset }) {
    const reference = error?.digest;

    return (
        <div className="flex min-h-[60vh] items-center justify-center px-4" role="alert">
            <div className="max-w-lg rounded-2xl border border-red-300/20 bg-red-950/20 p-8 text-center text-slate-100 shadow-xl">
                <AlertCircle className="mx-auto h-10 w-10 text-red-300" />
                <h1 className="mt-4 text-xl font-bold">Cette page a rencontré un problème</h1>
                <p className="mt-2 text-sm text-slate-300">Une erreur inattendue empêche cette page de s’afficher.</p>
                {reference && <p className="mt-2 text-xs text-slate-500">Référence : {reference}</p>}
                <Button type="button" variant="outline" onClick={reset} className="mt-6 border-white/15 bg-white/10 text-white hover:bg-white/15 hover:text-white">
                    <RefreshCcw className="mr-2 h-4 w-4" />
                    Réessayer
                </Button>
            </div>
        </div>
    );
}
