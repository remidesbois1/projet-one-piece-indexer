"use client";
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { ArrowRight, Search, Zap, Database, BookOpen, Layers } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

export default function LandingPage() {
    const [mangas, setMangas] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchMangas = async () => {
            try {
                const { data, error } = await supabase.from('mangas').select('*').order('titre');
                if (data) setMangas(data);
            } catch (e) {
                console.error(e);
            } finally {
                setLoading(false);
            }
        };
        fetchMangas();
    }, []);

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
            {/* Navbar simplifiée */}
            <header className="w-full border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
                <div className="container mx-auto px-6 h-16 flex items-center justify-between max-w-7xl">
                    <div className="flex items-center gap-3">
                        <img src="/favicon-96x96.png" alt="Projet Poneglyph Logo" className="h-10 w-10" />
                        <div className="text-lg font-bold text-slate-900 tracking-tight">
                            Projet Poneglyph
                        </div>
                    </div>

                    <div className="flex items-center gap-4">
                        <Link href="/login" prefetch={false}>
                            <Button variant="ghost" className="text-slate-600 hover:text-slate-900">
                                Connexion
                            </Button>
                        </Link>
                    </div>
                </div>
            </header>

            <main className="flex-1 container mx-auto px-6 py-12 max-w-5xl">
                <div className="text-center mb-16">
                    <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 text-slate-900">
                        Choisissez votre <span className="text-indigo-600">Univers</span>
                    </h1>
                    <p className="text-xl text-slate-500 max-w-2xl mx-auto">
                        Accédez à l'index sémantique de votre manga favori.
                    </p>
                </div>

                {loading ? (
                    <div className="flex justify-center p-12">
                        <div className="h-8 w-8 animate-spin border-4 border-slate-200 border-t-indigo-600 rounded-full"></div>
                    </div>
                ) : (
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                        {mangas.map((manga) => (
                            <Link key={manga.id} href={`/${manga.slug}/dashboard`} className="group">
                                <div className="bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm hover:shadow-xl transition-all duration-300 hover:-translate-y-1 h-full flex flex-col">
                                    <div className="aspect-[2/3] bg-slate-100 relative overflow-hidden">
                                        {manga.cover_url ? (
                                            <img src={manga.cover_url} alt={manga.titre} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center bg-slate-100 text-slate-300">
                                                <BookOpen className="h-16 w-16" />
                                            </div>
                                        )}
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-60 group-hover:opacity-40 transition-opacity"></div>
                                        <div className="absolute bottom-4 left-4 right-4">
                                            <h3 className="text-white text-2xl font-bold tracking-tight">{manga.titre}</h3>
                                        </div>
                                    </div>
                                    <div className="p-6 flex-1 flex flex-col">
                                        <p className="text-slate-500 text-sm line-clamp-3 mb-6 flex-1">
                                            {manga.description || "Aucune description disponible pour ce manga."}
                                        </p>
                                        <Button className="w-full bg-slate-900 group-hover:bg-indigo-600 transition-colors">
                                            Explorer <ArrowRight className="ml-2 h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            </Link>
                        ))}

                        {/* Placeholder for "Coming Soon" */}
                        <div className="bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 p-8 flex flex-col items-center justify-center text-center opacity-70 hover:opacity-100 transition-opacity">
                            <Layers className="h-12 w-12 text-slate-300 mb-4" />
                            <h3 className="text-lg font-semibold text-slate-900 mb-2">Bientôt plus...</h3>
                            <p className="text-sm text-slate-500">D'autres mangas seront ajoutés prochainement.</p>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
