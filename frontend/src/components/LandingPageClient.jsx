"use client";
import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import {
    ArrowRight, Search, BookOpen, Layers, ScanText, Cpu,
    BrainCircuit, Users, BarChart3, Eye, Globe, Workflow, ShieldCheck, Zap
} from "lucide-react";
import Image from "next/image";

const PONEGLYPH_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateSlots(count, seed = 0) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        const s = (seed + i) * 2654435761;
        const hash = (v) => ((s * (v + 1)) >>> 0) / 4294967296;
        slots.push({
            x: 2 + hash(1) * 96,
            y: 2 + hash(2) * 96,
            size: 28 + Math.floor(hash(3) * 36),
            rotate: Math.floor(hash(4) * 80) - 40,
            char: PONEGLYPH_LETTERS[Math.floor(hash(5) * 26)],
            opacity: 0,
        });
    }
    return slots;
}

function PoneglyphGlyphs({ count = 20, seed = 0 }) {
    const [glyphs, setGlyphs] = useState(() => generateSlots(count, seed));

    useEffect(() => {
        const timers = [];

        glyphs.forEach((_, i) => {
            const cycle = () => {
                const delay = 500 + Math.random() * 3500;
                const fadeIn = setTimeout(() => {
                    setGlyphs(prev => prev.map((g, idx) =>
                        idx === i ? { ...g, opacity: 1, char: PONEGLYPH_LETTERS[Math.floor(Math.random() * 26)] } : g
                    ));
                    const stayDuration = 2500 + Math.random() * 4500;
                    const fadeOut = setTimeout(() => {
                        setGlyphs(prev => prev.map((g, idx) =>
                            idx === i ? { ...g, opacity: 0 } : g
                        ));
                        const nextTimer = setTimeout(cycle, 1000 + Math.random() * 2000);
                        timers.push(nextTimer);
                    }, stayDuration);
                    timers.push(fadeOut);
                }, delay);
                timers.push(fadeIn);
            };
            cycle();
        });

        return () => timers.forEach(t => clearTimeout(t));
    }, []);

    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {glyphs.map((g, i) => (
                <span
                    key={i}
                    className="absolute select-none"
                    style={{
                        fontFamily: "'Poneglyph', serif",
                        fontSize: `${g.size}px`,
                        left: `${g.x}%`,
                        top: `${g.y}%`,
                        transform: `rotate(${g.rotate}deg)`,
                        opacity: g.opacity * 0.13,
                        transition: 'opacity 2.5s ease-in-out',
                        color: '#2F7AAF',
                        lineHeight: 1,
                    }}
                >
                    {g.char}
                </span>
            ))}
        </div>
    );
}


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
            className="group relative bg-white rounded-2xl border border-slate-200 p-6 transition-all duration-500 hover:shadow-lg hover:shadow-[#2F7AAF]/10 hover:-translate-y-1"
            style={{
                opacity: isInView ? 1 : 0,
                transform: isInView ? 'translateY(0)' : 'translateY(30px)',
                transition: `opacity 0.5s ${delay}ms, transform 0.5s ${delay}ms, box-shadow 0.3s, translate 0.3s`,
            }}
        >
            <div className="flex items-start gap-4 mb-3">
                <div className="h-11 w-11 rounded-xl bg-[#2F7AAF]/10 flex items-center justify-center shrink-0 group-hover:bg-[#2F7AAF]/15 transition-colors duration-300">
                    <Icon className="h-5 w-5 text-[#2F7AAF]" />
                </div>
                <div>
                    <h3 className="text-base font-semibold text-slate-900">{title}</h3>
                    {badge && <span className="inline-block mt-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-[#2F7AAF]/10 text-[#2F7AAF] border border-[#2F7AAF]/20">{badge}</span>}
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
            <div className="text-3xl md:text-4xl font-bold text-[#2F7AAF] mb-1">{value}</div>
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
                className="bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm hover:shadow-xl hover:shadow-[#2F7AAF]/10 transition-all duration-500 hover:-translate-y-1.5 h-full flex flex-col"
                style={{
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? 'translateY(0)' : 'translateY(30px)',
                    transition: 'opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1), transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s',
                }}
            >
                <div className="aspect-[3/4] bg-slate-100 relative overflow-hidden">
                    {manga.cover_url ? (
                        <Image
                            src={manga.cover_url}
                            alt={`Couverture du manga ${manga.titre}`}
                            fill
                            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                            className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
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
                    <div className="flex items-center text-[#2F7AAF] text-sm font-medium group-hover:gap-2 transition-all duration-300">
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
        title: "OCR Local - TrOCR Fine-tuned",
        badge: "WebGPU",
        description: "Modèles spécialisés (Base/Large) fine-tunés sur la typographie manga, exécutés via WebGPU.",
        details: ["TrOCR Large", "558M Params", "2.33 Go ONNX", "Split Multi-lignes", "CER 1.83%", "WER 6.03%"],
    },
    {
        icon: Zap,
        title: "OCR Serverless - LightOnOCR",
        badge: "SOTA",
        description: "Modèle de pointe (Architecture LightOnOCR fine-tuné) déployé sur Modal (GPU L4). Précision extrême pour les cas complexes.",
        details: ["LightOnOCR", "CER < 0.5%", "WER < 2%", "GPU L4", "Serverless"],
    },
    {
        icon: BrainCircuit,
        title: "OCR Cloud - Gemini Flash-Lite",
        description: "Fallback côté serveur et moteur de distillation pour l'entraînement des modèles locaux. Génère le corpus de vérité terrain.",
        details: ["~0.00008$ / OCR"],
    },
    {
        icon: Eye,
        title: "Détection de Bulles - YOLO11",
        badge: "WebGPU",
        description: "YOLO11 Nano fine-tuné pour isoler chaque zone de texte, exécuté via ONNX Runtime Web avec une précision quasi-parfaite.",
        details: ["mAP50 0.994", "YOLO11 Nano", "ONNX", "WebGPU"],
    },
    {
        icon: Workflow,
        title: "Tri des Bulles - ReaderNet V5",
        badge: "ML",
        description: "Architecture Global-Local (MobileNetV3 + MLP) pour ordonner les bulles selon le sens de lecture japonais, optimisée pour le navigateur.",
        details: ["ReaderNet V5", "98.0% Accuracy", "2.47 MB ONNX", "Web Worker"],
    },
    {
        icon: Search,
        title: "Recherche Sémantique & Indexation",
        description: "Architecture hybride multicouche (Voyage AI + Gemini Multimodal) avec consensus scoring (1.15x) et stockage vectoriel pgvector.",
        details: ["voyage-4-large", "gemini-embedding-2-preview", "pgvector"],
    },
];

export default function LandingPageClient({ mangas = [] }) {
    const heroRef = useRef(null);
    const heroInView = useInView(heroRef);

    return (
        <>
            <header className="w-full border-b border-slate-200/80 bg-white/85 backdrop-blur-md sticky top-0 z-50">
                <div className="container mx-auto px-6 h-14 flex items-center justify-between max-w-7xl">
                    <a href="#" className="flex items-center gap-2.5 group">
                        <Image src="/favicon-96x96.png" alt="Logo Projet Poneglyph" width={32} height={32} className="transition-transform duration-200 group-hover:scale-105" />
                        <span className="text-lg font-bold text-slate-900 tracking-tight">Projet Poneglyph</span>
                    </a>
                    <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-500">
                        <a href="#features" className="hover:text-slate-900 transition-colors duration-200">Fonctionnalités</a>
                        <a href="#mangas" className="hover:text-slate-900 transition-colors duration-200">Mangas</a>
                        <Link href="/sandbox" className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#2F7AAF]/10 text-[#2F7AAF] border border-[#2F7AAF]/20 hover:bg-[#2F7AAF]/20 transition-colors duration-200">
                            <Cpu size={14} />
                            <span>Sandbox</span>
                        </Link>
                        <a href="#about" className="hover:text-slate-900 transition-colors duration-200">À propos</a>
                    </nav>
                </div>
            </header>

            <section className="relative overflow-hidden">
                <div className="absolute inset-0 -z-10">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] bg-[#2F7AAF]/10 rounded-full blur-3xl" />
                    <div className="absolute top-20 right-0 w-[400px] h-[400px] bg-[#2F7AAF]/8 rounded-full blur-3xl" />
                    <div className="absolute top-40 left-0 w-[300px] h-[300px] bg-sky-100/30 rounded-full blur-3xl" />
                </div>
                <PoneglyphGlyphs />

                <div
                    ref={heroRef}
                    className="container mx-auto px-6 pt-20 pb-24 max-w-5xl text-center"
                    style={{
                        opacity: heroInView ? 1 : 0,
                        transform: heroInView ? 'translateY(0)' : 'translateY(30px)',
                        transition: 'opacity 0.7s, transform 0.7s',
                    }}
                >
                    <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#2F7AAF]/25 bg-[#2F7AAF]/8 text-[#2F7AAF] text-xs font-medium mb-8">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#2F7AAF] opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#2F7AAF]" />
                        </span>
                        Projet Communautaire & Open-Source
                    </div>

                    <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 leading-[1.1]">
                        Retrouvez la page
                        <br />
                        <span className="text-[#2F7AAF]">que vous cherchez</span>
                    </h1>
                    <p className="text-lg md:text-xl text-slate-500 max-w-2xl mx-auto mb-10 leading-relaxed">
                        Une citation ? Un combat ? Un moment émouvant ? Décrivez ce que vous cherchez pour tomber pile sur la bonne page, sans avoir à feuilleter des dizaines de tomes.
                    </p>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                        <a href="#mangas">
                            <Button size="lg" className="bg-[#2F7AAF] hover:bg-[#2a6591] text-white px-8 h-12 text-base shadow-lg shadow-[#2F7AAF]/25 cursor-pointer">
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

                    <div className="mt-12 p-8 rounded-2xl bg-gradient-to-br from-[#2F7AAF]/5 to-sky-50 border border-[#2F7AAF]/10 flex flex-col md:flex-row items-center justify-between gap-8">
                        <div className="max-w-xl text-left">
                            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-white border border-[#2F7AAF]/20 text-[#2F7AAF] text-[11px] font-bold uppercase tracking-wider mb-4">
                                Démonstration Technique
                            </div>
                            <h3 className="text-2xl font-bold text-slate-900 mb-3">Testez l'annotation en local</h3>
                            <p className="text-slate-600 text-sm leading-relaxed">
                                Curieux de voir comment l'IA détecte les bulles et transcrit le texte ? La <strong>Sandbox</strong> vous permet d'uploader vos propres images et de tester l'inférence locale (WebGPU) sans aucun compte ni installation.
                            </p>
                        </div>
                        <Link href="/sandbox">
                            <Button className="bg-[#2F7AAF] hover:bg-[#2a6591] text-white px-8 h-12 text-sm font-semibold shadow-lg shadow-[#2F7AAF]/20 whitespace-nowrap cursor-pointer">
                                Ouvrir la Sandbox
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </Link>
                    </div>
                </div>
            </section>

            <section id="mangas" className="py-20 relative overflow-hidden">
                <PoneglyphGlyphs count={14} seed={42} />
                <div className="container mx-auto px-6 max-w-6xl relative z-10">
                    <div className="text-center mb-14">
                        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
                            Mangas disponibles
                        </h2>
                        <p className="text-slate-500 max-w-xl mx-auto">
                            Choisissez un manga pour accéder à son index, contribuer aux annotations ou lancer une recherche.
                        </p>
                    </div>

                    {!mangas || mangas.length === 0 ? (
                        <div className="flex justify-center p-12">
                            <p className="text-slate-400">Aucun manga disponible.</p>
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
                    <div className="relative rounded-3xl p-10 md:p-14 text-center overflow-hidden" style={{ background: 'linear-gradient(145deg, #1e293b, #0f172a)' }}>
                        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M30 5L45 20L30 35L15 20Z' fill='none' stroke='%23fff' stroke-width='0.5'/%3E%3Cpath d='M10 40L20 30L30 40L20 50Z' fill='none' stroke='%23fff' stroke-width='0.5'/%3E%3Cpath d='M40 45L50 35L55 45L50 55Z' fill='none' stroke='%23fff' stroke-width='0.5'/%3E%3C/svg%3E")`, backgroundSize: '60px 60px' }} />
                        <div className="relative z-10">
                            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white mb-4">
                                Un projet communautaire
                            </h2>
                            <p className="text-slate-300 max-w-2xl mx-auto mb-6 leading-relaxed">
                                Projet Poneglyph est un outil open-source conçu pour les passionnés de manga.
                                Grâce à l'intelligence artificielle et à la contribution de sa communauté,
                                chaque page est transcrite, indexée et rendue recherchable.
                            </p>
                            <div className="flex items-start gap-3 text-left max-w-2xl mx-auto p-4 rounded-xl bg-white/5 border border-white/10">
                                <ShieldCheck className="h-5 w-5 text-amber-400/70 shrink-0 mt-0.5" />
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
                </div>
            </section>

            <footer className="py-10 border-t border-slate-200 bg-slate-50">
                <div className="container mx-auto px-6 max-w-6xl">
                    <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-2.5">
                            <Image src="/favicon-96x96.png" alt="Logo Projet Poneglyph" width={28} height={28} />
                            <span className="text-sm font-semibold text-slate-900">Projet Poneglyph</span>
                        </div>
                        <p className="text-xs text-slate-400 text-center md:text-right leading-relaxed max-w-sm">
                            Merci à <em>Chip Huyen</em> pour <em>AI Engineering</em> (O'Reilly, 2025),
                            source d'inspiration majeure pour l'orchestration et l'infrastructure hybride de ce projet.
                        </p>
                    </div>
                </div>
            </footer>
        </>
    );
}
