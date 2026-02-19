"use client";
import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import {
    ArrowRight, Search, BookOpen, Layers, ScanText, Cpu,
    BrainCircuit, Users, BarChart3, Eye, Globe, Workflow, ShieldCheck
} from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

function useInView(ref, options = {}) {
    const [isInView, setIsInView] = useState(false);
    useEffect(() => {
        if (!ref.current) return;
        const observer = new IntersectionObserver(
            ([entry]) => { if (entry.isIntersecting) setIsInView(true); },
            { threshold: 0.15, ...options }
        );
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, [ref]);
    return isInView;
}

function FeatureCard({ icon: Icon, title, description, delay, badge, details }) {
    const ref = useRef(null);
    const isInView = useInView(ref);

    return (
        <div
            ref={ref}
            className="group relative bg-white rounded-2xl border border-slate-200 p-6 transition-all duration-500 hover:shadow-lg hover:shadow-indigo-100/50 hover:-translate-y-1"
            style={{
                opacity: isInView ? 1 : 0,
                transform: isInView ? 'translateY(0)' : 'translateY(30px)',
                transition: `opacity 0.5s ${delay}ms, transform 0.5s ${delay}ms, box-shadow 0.3s, translate 0.3s`,
            }}
        >
            <div className="flex items-start gap-4 mb-3">
                <div className="h-11 w-11 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0 group-hover:bg-indigo-100 transition-colors duration-300">
                    <Icon className="h-5 w-5 text-indigo-600" />
                </div>
                <div>
                    <h3 className="text-base font-semibold text-slate-900">{title}</h3>
                    {badge && <span className="inline-block mt-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100">{badge}</span>}
                </div>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed mb-3">{description}</p>
            {details && (
                <div className="flex flex-wrap gap-1.5">
                    {details.map((d, i) => (
                        <span key={i} className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-100 text-slate-500 border border-slate-150">{d}</span>
                    ))}
                </div>
            )}
        </div>
    );
}

function StatItem({ value, label, delay }) {
    const ref = useRef(null);
    const isInView = useInView(ref);

    return (
        <div
            ref={ref}
            className="text-center"
            style={{
                opacity: isInView ? 1 : 0,
                transform: isInView ? 'translateY(0)' : 'translateY(20px)',
                transition: `opacity 0.5s ${delay}ms, transform 0.5s ${delay}ms`,
            }}
        >
            <div className="text-3xl md:text-4xl font-bold text-indigo-600 mb-1">{value}</div>
            <div className="text-sm text-slate-500">{label}</div>
        </div>
    );
}

function MangaCard({ manga, index }) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setIsVisible(true), 100 + index * 120);
        return () => clearTimeout(timer);
    }, [index]);

    return (
        <Link href={`/${manga.slug}/dashboard`} className="group block">
            <div
                className="bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm hover:shadow-xl hover:shadow-indigo-100/40 transition-all duration-500 hover:-translate-y-1.5 h-full flex flex-col"
                style={{
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? 'translateY(0)' : 'translateY(30px)',
                    transition: 'opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1), transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s',
                }}
            >
                <div className="aspect-[3/4] bg-slate-100 relative overflow-hidden">
                    {manga.cover_url ? (
                        <img
                            src={manga.cover_url}
                            alt={manga.titre}
                            className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center bg-slate-50 text-slate-300">
                            <BookOpen className="h-16 w-16" />
                        </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent opacity-60 group-hover:opacity-40 transition-opacity duration-300" />
                    <div className="absolute bottom-4 left-4 right-4">
                        <h3 className="text-white text-xl font-bold tracking-tight drop-shadow-sm">{manga.titre}</h3>
                    </div>
                </div>
                <div className="p-5 flex-1 flex flex-col">
                    <p className="text-slate-500 text-sm line-clamp-2 mb-4 flex-1 leading-relaxed">
                        {manga.description || "Aucune description disponible pour ce manga."}
                    </p>
                    <div className="flex items-center text-indigo-600 text-sm font-medium group-hover:gap-2 transition-all duration-300">
                        Explorer <ArrowRight className="ml-1.5 h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                    </div>
                </div>
            </div>
        </Link>
    );
}

const features = [
    {
        icon: ScanText,
        title: "OCR Local — TrOCR Fine-tuned",
        badge: "WebGPU",
        description: "Modèle TrOCR fine-tuné sur la typographie manga, exécuté directement dans le navigateur via WebGPU. Zéro coût serveur.",
        details: ["CER 1.31%", "WER 3.71%", "ONNX", "Post-processing Regex"],
    },
    {
        icon: Eye,
        title: "Détection de Bulles — YOLOv8",
        badge: "WebGPU",
        description: "YOLOv8 Medium fine-tuné pour détecter les zones de texte sur chaque planche, exécuté côté client via ONNX Runtime Web.",
        details: ["mAP50 0.97", "Temps réel", "ONNX"],
    },
    {
        icon: Search,
        title: "Recherche Sémantique & Indexation",
        description: "Chaque page est encodée en vecteurs 1024d par Voyage AI et stockée dans PostgreSQL (pgvector). Les requêtes sont comparées par similarité cosinus puis réordonnées par reranking.",
        details: ["voyage-4-large", "rerank-2.5", "pgvector", "1024 dimensions", "Supabase"],
    },
    {
        icon: Cpu,
        title: "OCR Cloud — Gemini Flash-Lite",
        description: "Alternative côté serveur via Google Gemini 2.5 Flash-Lite pour les utilisateurs qui le souhaitent. Également utilisé pour générer le corpus de distillation du modèle local.",
        details: ["~0.00004$ / OCR", "Distillation"],
    },
];

export default function LandingPage() {
    const [mangas, setMangas] = useState([]);
    const [loading, setLoading] = useState(true);
    const heroRef = useRef(null);
    const heroInView = useInView(heroRef);

    useEffect(() => {
        const fetchMangas = async () => {
            try {
                const { data } = await supabase.from('mangas').select('*').eq('enabled', true).order('titre');
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
            <header className="w-full border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
                <div className="container mx-auto px-6 h-16 flex items-center justify-between max-w-7xl">
                    <div className="flex items-center gap-3">
                        <img src="/favicon-96x96.png" alt="Projet Poneglyph Logo" className="h-9 w-9" />
                        <span className="text-lg font-bold text-slate-900 tracking-tight">Projet Poneglyph</span>
                    </div>
                    <nav className="hidden md:flex items-center gap-8 text-sm text-slate-500">
                        <a href="#features" className="hover:text-slate-900 transition-colors">Fonctionnalités</a>
                        <a href="#mangas" className="hover:text-slate-900 transition-colors">Mangas</a>
                        <a href="#about" className="hover:text-slate-900 transition-colors">À propos</a>
                    </nav>
                </div>
            </header>

            <section className="relative overflow-hidden">
                <div className="absolute inset-0 -z-10">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] bg-indigo-100/40 rounded-full blur-3xl" />
                    <div className="absolute top-20 right-0 w-[400px] h-[400px] bg-violet-100/30 rounded-full blur-3xl" />
                    <div className="absolute top-40 left-0 w-[300px] h-[300px] bg-sky-100/30 rounded-full blur-3xl" />
                </div>

                <div
                    ref={heroRef}
                    className="container mx-auto px-6 pt-20 pb-24 max-w-5xl text-center"
                    style={{
                        opacity: heroInView ? 1 : 0,
                        transform: heroInView ? 'translateY(0)' : 'translateY(30px)',
                        transition: 'opacity 0.7s, transform 0.7s',
                    }}
                >
                    <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs font-medium mb-8">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
                        </span>
                        Projet open-source actif
                    </div>

                    <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 leading-[1.1]">
                        L'index sémantique
                        <br />
                        <span className="text-indigo-600">de vos mangas</span>
                    </h1>
                    <p className="text-lg md:text-xl text-slate-500 max-w-2xl mx-auto mb-10 leading-relaxed">
                        Recherche intelligente, OCR, indexation collaborative et bien plus.
                        Retrouvez n'importe quelle scène en quelques mots.
                    </p>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                        <a href="#mangas">
                            <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 h-12 text-base shadow-lg shadow-indigo-200 cursor-pointer">
                                Explorer les mangas
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </a>
                        <a href="#features">
                            <Button size="lg" variant="outline" className="border-slate-300 text-slate-700 px-8 h-12 text-base hover:bg-slate-100 cursor-pointer">
                                Découvrir le projet
                            </Button>
                        </a>
                    </div>
                </div>
            </section>

            <section id="features" className="py-20 bg-white border-y border-slate-100">
                <div className="container mx-auto px-6 max-w-6xl">
                    <div className="text-center mb-14">
                        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
                            Architecture & Technologies
                        </h2>
                        <p className="text-slate-500 max-w-2xl mx-auto">
                            Une infrastructure hybride Edge/Cloud conçue pour minimiser les coûts serveur en déportant l'inférence IA directement dans le navigateur.
                        </p>
                    </div>

                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                        {features.map((feature, i) => (
                            <FeatureCard key={i} {...feature} delay={i * 80} />
                        ))}
                    </div>
                </div>
            </section>

            <section className="py-16 bg-slate-50">
                <div className="container mx-auto px-6 max-w-5xl">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
                        <StatItem value="1.31%" label="CER (post-traitement)" delay={0} />
                        <StatItem value="0.97" label="mAP50 détection" delay={80} />
                        <StatItem value="0$" label="Coût OCR local" delay={160} />
                        <StatItem value="~4.50€" label="Coût mensuel total" delay={240} />
                        <StatItem value="2048d" label="Vecteurs Voyage AI" delay={320} />
                    </div>
                </div>
            </section>

            <section id="mangas" className="py-20">
                <div className="container mx-auto px-6 max-w-6xl">
                    <div className="text-center mb-14">
                        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
                            Mangas disponibles
                        </h2>
                        <p className="text-slate-500 max-w-xl mx-auto">
                            Choisissez un manga pour accéder à son index, contribuer aux annotations ou lancer une recherche.
                        </p>
                    </div>

                    {loading ? (
                        <div className="flex justify-center p-12">
                            <div className="h-8 w-8 animate-spin border-4 border-slate-200 border-t-indigo-600 rounded-full" />
                        </div>
                    ) : (
                        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-7">
                            {mangas.map((manga, i) => (
                                <MangaCard key={manga.id} manga={manga} index={i} />
                            ))}

                            <div className="rounded-2xl border-2 border-dashed border-slate-200 p-8 flex flex-col items-center justify-center text-center hover:border-slate-300 transition-colors duration-300">
                                <Layers className="h-10 w-10 text-slate-300 mb-4" />
                                <h3 className="text-base font-semibold text-slate-900 mb-1">Bientôt plus...</h3>
                                <p className="text-sm text-slate-500">D'autres mangas seront ajoutés prochainement.</p>
                            </div>
                        </div>
                    )}
                </div>
            </section>

            <section id="about" className="py-20 bg-white border-t border-slate-100">
                <div className="container mx-auto px-6 max-w-4xl">
                    <div className="bg-gradient-to-br from-indigo-50 via-white to-violet-50 rounded-3xl border border-indigo-100 p-10 md:p-14 text-center">
                        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
                            Un projet communautaire
                        </h2>
                        <p className="text-slate-500 max-w-2xl mx-auto mb-4 leading-relaxed">
                            Projet Poneglyph est un outil open-source conçu pour les passionnés de manga.
                            Grâce à l'intelligence artificielle et à la contribution de sa communauté,
                            chaque page est transcrite, indexée et rendue recherchable.
                        </p>
                        <div className="flex items-start gap-3 text-left max-w-2xl mx-auto mt-6 p-4 rounded-xl bg-white/60 border border-slate-200">
                            <ShieldCheck className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                            <p className="text-slate-400 text-xs leading-relaxed">
                                Ce projet est une démonstration technique à but éducatif et de recherche.
                                Afin de respecter les droits d'auteur et prévenir toute utilisation à des fins de lecture illégale,
                                les images accessibles publiquement sont systématiquement réduites en qualité et marquées d'un filigrane visible.
                                Ces dégradations volontaires garantissent que l'expérience ne peut se substituer à l'achat
                                et à la lecture de l'œuvre originale. Toutes les images restent la propriété de leurs ayants droit respectifs.
                            </p>
                        </div>
                    </div>
                </div>
            </section>

            <footer className="py-10 border-t border-slate-200 bg-slate-50">
                <div className="container mx-auto px-6 max-w-6xl">
                    <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-2.5">
                            <img src="/favicon-96x96.png" alt="Logo" className="h-7 w-7" />
                            <span className="text-sm font-semibold text-slate-900">Projet Poneglyph</span>
                        </div>
                        <p className="text-xs text-slate-400 text-center md:text-right leading-relaxed max-w-sm">
                            Merci à <em>Chip Huyen</em> pour <em>AI Engineering</em> (O'Reilly, 2025),
                            source d'inspiration majeure pour l'orchestration et l'infrastructure hybride de ce projet.
                        </p>
                    </div>
                </div>
            </footer>
        </div>
    );
}
