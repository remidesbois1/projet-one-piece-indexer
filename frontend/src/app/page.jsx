"use client";
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { ArrowRight, Search, Zap, Database, BookOpen, Github } from "lucide-react";
import { getLandingStats } from '@/lib/api';

export default function LandingPage() {
    const [stats, setStats] = useState({ chapters: 0, pages: 0, words: 0 });

    useEffect(() => {
        getLandingStats().then(res => setStats(res.data)).catch(console.error);
    }, []);
    return (
        <div className="min-h-screen bg-white text-slate-900 flex flex-col font-sans">

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
                        <Link href="/dashboard" prefetch={false}>
                            <Button className="bg-slate-900 hover:bg-slate-800 text-white shadow-sm">
                                Accéder à l'App
                            </Button>
                        </Link>
                    </div>
                </div>
            </header>

            <main className="flex-1">
                {/* HERO */}
                <section className="relative pt-24 pb-32 overflow-hidden border-b border-slate-100">
                    <div className="container mx-auto px-6 text-center max-w-4xl">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-sm font-medium mb-8 border border-slate-200">
                            <span className="flex h-2 w-2 rounded-full bg-emerald-500"></span>
                            <span className="font-mono text-xs">VERSION BETA</span>
                        </div>

                        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 text-slate-900 leading-[1.1]">
                            L'Encyclopédie Sémantique <br />
                            <span className="text-slate-500">One Piece</span>
                        </h1>

                        <p className="text-lg md:text-xl text-slate-500 mb-10 max-w-2xl mx-auto leading-relaxed">
                            Explorez l'œuvre d'Eiichiro Oda avec la puissance de l'IA. Recherche vectorielle, extraction de texte WebGPU et indexation contextuelle.
                        </p>

                        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                            <Link href="/dashboard" prefetch={false}>
                                <Button size="lg" className="h-12 px-8 text-base bg-slate-900 hover:bg-slate-800 text-white min-w-[200px]">
                                    Commencer <ArrowRight className="ml-2 h-4 w-4" />
                                </Button>
                            </Link>
                            <Link href="https://github.com/remidesbois1/projet-one-piece-indexer" target="_blank">
                                <Button variant="outline" size="lg" className="h-12 px-8 text-base border-slate-200 text-slate-700 hover:bg-slate-50 min-w-[200px]">
                                    <Github className="mr-2 h-4 w-4" /> GitHub
                                </Button>
                            </Link>
                        </div>
                    </div>
                </section>

                {/* FEATURES */}
                <section className="py-24 bg-slate-50/50">
                    <div className="container mx-auto px-6 max-w-7xl">
                        <div className="grid md:grid-cols-3 gap-8">
                            {/* Feature 1 */}
                            <div className="p-8 rounded-xl bg-white border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                                <div className="h-12 w-12 bg-indigo-50 rounded-lg flex items-center justify-center mb-6">
                                    <Search className="h-6 w-6 text-indigo-600" />
                                </div>
                                <h3 className="text-lg font-semibold mb-3 text-slate-900">Recherche Sémantique</h3>
                                <p className="text-slate-500 leading-relaxed text-sm">
                                    Retrouvez une planche non pas par mots-clés, mais par le sens. Décrivez une action, une émotion ou une scène complexe.
                                </p>
                            </div>

                            {/* Feature 2 */}
                            <div className="p-8 rounded-xl bg-white border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                                <div className="h-12 w-12 bg-emerald-50 rounded-lg flex items-center justify-center mb-6">
                                    <Zap className="h-6 w-6 text-emerald-600" />
                                </div>
                                <h3 className="text-lg font-semibold mb-3 text-slate-900">Extraction Hybride</h3>
                                <p className="text-slate-500 leading-relaxed text-sm">
                                    Flexibilité totale : utilisez la puissance locale de votre GPU (WebGPU) ou la précision du Cloud via l'API Gemini.
                                </p>
                            </div>

                            {/* Feature 3 */}
                            <div className="p-8 rounded-xl bg-white border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                                <div className="h-12 w-12 bg-amber-50 rounded-lg flex items-center justify-center mb-6">
                                    <Database className="h-6 w-6 text-amber-600" />
                                </div>
                                <h3 className="text-lg font-semibold mb-3 text-slate-900">Analyses Statistiques</h3>
                                <p className="text-slate-500 leading-relaxed text-sm">
                                    Constitution d'un corpus intégral de l'œuvre permettant des recherches de texte précises et des analyses statistiques globales.
                                </p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* STATS / INFO */}
                <section className="py-24 border-t border-slate-200 bg-white">
                    <div className="container mx-auto px-6 max-w-7xl">
                        <div className="flex flex-col lg:flex-row items-center justify-between gap-16">
                            <div className="space-y-8 flex-1">
                                <div>
                                    <h2 className="text-3xl font-bold text-slate-900 mb-4 tracking-tight">Architecture & <br />Technologie</h2>
                                    <p className="text-slate-500 text-lg">Conçu pour la performance et le passage à l'échelle, utilisant les dernières avancées en IA.</p>
                                </div>

                                <div className="space-y-4">
                                    <div className="flex items-start gap-4 p-4 rounded-lg bg-slate-50 border border-slate-100">
                                        <div className="mt-1 h-2 w-2 rounded-full bg-emerald-500 shrink-0"></div>
                                        <div>
                                            <h4 className="font-semibold text-slate-900 text-sm">Florence-2 & WebGPU</h4>
                                            <p className="text-sm text-slate-500 mt-1">OCR exécuté localement dans le navigateur. Gratuitée.</p>
                                        </div>
                                    </div>
                                    <div className="flex items-start gap-4 p-4 rounded-lg bg-slate-50 border border-slate-100">
                                        <div className="mt-1 h-2 w-2 rounded-full bg-indigo-500 shrink-0"></div>
                                        <div>
                                            <h4 className="font-semibold text-slate-900 text-sm">Gemini 2.5 Flash Lite</h4>
                                            <p className="text-sm text-slate-500 mt-1">Analyse multimodale avancée pour un OCR parfait.</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Visual Card */}
                            <div className="flex-1 w-full max-w-md">
                                <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
                                    <div className="flex flex-col items-center text-center space-y-8">
                                        <div className="space-y-1">
                                            <div className="text-5xl font-mono font-bold text-slate-900 tracking-tighter">
                                                {stats.pages > 0 ? stats.pages.toLocaleString() : "..."}
                                            </div>
                                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Pages Indexées</div>
                                        </div>

                                        <div className="w-full h-px bg-slate-100"></div>

                                        <div className="grid grid-cols-2 gap-4 w-full">
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-slate-900 font-mono">
                                                    {stats.chapters > 0 ? stats.chapters.toLocaleString() : "..."}
                                                </div>
                                                <div className="text-[10px] text-slate-400 uppercase mt-1">Chapitres</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-slate-900 font-mono">
                                                    {stats.words > 0 ? stats.words.toLocaleString() : "..."}
                                                </div>
                                                <div className="text-[10px] text-slate-400 uppercase mt-1">Mots (Est.)</div>
                                            </div>
                                        </div>

                                        <div className="w-full rounded bg-slate-50 border border-slate-100 p-3 text-left">
                                            <div className="font-mono text-xs text-emerald-600 flex items-center gap-2">
                                                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                                                Données en temps réel
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* FOOTER */}
                <footer className="py-8 border-t border-slate-200 bg-white">
                    <div className="container mx-auto px-6 max-w-7xl flex flex-col md:flex-row items-center justify-between text-slate-500 text-sm">
                        <div className="mb-4 md:mb-0">
                            <span className="font-semibold text-slate-700">Projet Poneglyph</span>
                            <span className="mx-2">·</span>
                            <span>© 2026</span>
                        </div>
                        <div className="flex items-center gap-6">
                            <Link href="https://github.com/remidesbois1/" className="hover:text-slate-900 transition-colors">GitHub</Link>
                            <Link href="/login" prefetch={false} className="hover:text-slate-900 transition-colors">Connexion</Link>
                        </div>
                    </div>
                </footer>
            </main>
        </div>
    );
}
