"use client";

import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
    ArrowRight,
    BookOpen,
    Boxes,
    Cpu,
    Github,
    Heart,
    Info,
    Layers,
    Mail,
    MessageCircle,
    PlayCircle,
    ScanText,
    Search,
    ShieldCheck,
    Sparkles,
    Zap,
} from "lucide-react";

const PONEGLYPH_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function generateSlots(count, seed = 0) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        const s = (seed + i) * 2654435761;
        const hash = (v) => ((s * (v + 1)) >>> 0) / 4294967296;
        slots.push({
            x: 2 + hash(1) * 96,
            y: 2 + hash(2) * 96,
            size: 22 + Math.floor(hash(3) * 38),
            rotate: Math.floor(hash(4) * 90) - 45,
            char: PONEGLYPH_LETTERS[Math.floor(hash(5) * 26)],
            opacity: 0,
        });
    }
    return slots;
}

function PoneglyphGlyphs({ count = 18, seed = 0 }) {
    const [glyphs, setGlyphs] = useState(() => generateSlots(count, seed));

    useEffect(() => {
        const timers = [];

        Array.from({ length: count }).forEach((_, i) => {
            const cycle = () => {
                const fadeIn = setTimeout(() => {
                    setGlyphs((prev) => prev.map((g, idx) => (
                        idx === i ? { ...g, opacity: 1, char: PONEGLYPH_LETTERS[Math.floor(Math.random() * 26)] } : g
                    )));
                    const fadeOut = setTimeout(() => {
                        setGlyphs((prev) => prev.map((g, idx) => (
                            idx === i ? { ...g, opacity: 0 } : g
                        )));
                        timers.push(setTimeout(cycle, 1300 + Math.random() * 2600));
                    }, 2400 + Math.random() * 4200);
                    timers.push(fadeOut);
                }, 500 + Math.random() * 3200);
                timers.push(fadeIn);
            };
            cycle();
        });

        return () => timers.forEach((timer) => clearTimeout(timer));
    }, [count]);

    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {glyphs.map((g, i) => (
                <span
                    key={i}
                    className="absolute select-none text-[#4d93ff]"
                    style={{
                        fontFamily: "'Poneglyph', serif",
                        fontSize: `${g.size}px`,
                        left: `${g.x}%`,
                        top: `${g.y}%`,
                        transform: `rotate(${g.rotate}deg)`,
                        opacity: g.opacity * 0.18,
                        transition: "opacity 2.5s ease-in-out",
                        lineHeight: 1,
                    }}
                >
                    {g.char}
                </span>
            ))}
        </div>
    );
}

function useInView(ref) {
    const [isInView, setIsInView] = useState(false);

    useEffect(() => {
        if (!ref.current) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) setIsInView(true);
            },
            { threshold: 0.15 }
        );
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, [ref]);

    return isInView;
}

const GlassPanel = React.forwardRef(function GlassPanel({ children, className = "", style }, ref) {
    return (
        <div ref={ref} style={style} className={`rounded-lg border border-white/14 bg-[#071625]/72 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl ${className}`}>
            {children}
        </div>
    );
});

function FeatureCard({ icon: Icon, title, badge, description, details, delay }) {
    const ref = useRef(null);
    const isInView = useInView(ref);

    return (
        <GlassPanel
            ref={ref}
            className="group min-h-[220px] p-5 transition duration-300 hover:-translate-y-1 hover:border-[#6da7ff]/45 hover:bg-[#0a1d30]/86"
            style={{
                opacity: isInView ? 1 : 0,
                transform: isInView ? "translateY(0)" : "translateY(24px)",
                transition: `opacity 0.55s ${delay}ms, transform 0.55s ${delay}ms, border-color 0.25s, background-color 0.25s`,
            }}
        >
            <div className="mb-4 flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-[#6da7ff]/28 bg-[#2f7aaf]/22 text-[#8dbbff] shadow-[0_0_28px_rgba(47,122,175,0.22)]">
                    <Icon size={22} />
                </div>
                <div className="min-w-0">
                    <h3 className="text-base font-semibold leading-snug text-white">{title}</h3>
                    {badge && (
                        <span className="mt-1.5 inline-flex rounded-md border border-[#8dbbff]/20 bg-[#8dbbff]/10 px-2 py-0.5 text-[11px] font-medium text-[#bdd6ff]">
                            {badge}
                        </span>
                    )}
                </div>
            </div>
            <p className="mb-4 text-sm leading-relaxed text-slate-300/86">{description}</p>
            <div className="flex flex-wrap gap-2">
                {details.map((detail) => (
                    <span key={detail} className="rounded-md border border-white/10 bg-white/[0.055] px-2.5 py-1 text-[11px] font-medium text-slate-300">
                        {detail}
                    </span>
                ))}
            </div>
        </GlassPanel>
    );
}

function MangaCard({ manga, index }) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setIsVisible(true), 120 + index * 110);
        return () => clearTimeout(timer);
    }, [index]);

    return (
        <Link href={`/${manga.slug}/dashboard`} className="group block">
            <GlassPanel
                className="grid min-h-[220px] grid-cols-[120px_1fr] overflow-hidden transition duration-300 hover:-translate-y-1 hover:border-[#6da7ff]/42 sm:grid-cols-[150px_1fr]"
                style={{
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? "translateY(0)" : "translateY(24px)",
                    transition: "opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1), transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s",
                }}
            >
                <div className="relative min-h-[220px] bg-[#0b1624]">
                    {manga.cover_url ? (
                        <Image
                            src={manga.cover_url}
                            alt={`Couverture du manga ${manga.titre}`}
                            fill
                            sizes="(max-width: 640px) 120px, 150px"
                            className="object-cover transition duration-700 group-hover:scale-105"
                        />
                    ) : (
                        <div className="flex h-full items-center justify-center text-slate-500">
                            <BookOpen size={40} />
                        </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#06101b]/60 to-transparent" />
                </div>
                <div className="flex min-w-0 flex-col p-5">
                    <span className="mb-4 w-fit rounded-md border border-white/13 bg-white/[0.065] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                        Disponible
                    </span>
                    <h3 className="text-xl font-semibold text-white">{manga.titre}</h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {manga.total_chapitres && (
                            <span className="rounded-md border border-white/10 bg-white/[0.055] px-2 py-1 text-[11px] text-slate-300">
                                {manga.total_chapitres} chapitres
                            </span>
                        )}
                        {manga.total_tomes && (
                            <span className="rounded-md border border-white/10 bg-white/[0.055] px-2 py-1 text-[11px] text-slate-300">
                                {manga.total_tomes} tomes
                            </span>
                        )}
                    </div>
                    <p className="mt-4 line-clamp-3 text-sm leading-relaxed text-slate-300/82">
                        {manga.description || "Un index communautaire pour retrouver les pages, les scènes et les dialogues marquants."}
                    </p>
                    <div className="mt-auto flex items-center gap-2 pt-5 text-sm font-semibold text-[#8dbbff]">
                        Explorer <ArrowRight size={15} className="transition group-hover:translate-x-1" />
                    </div>
                </div>
            </GlassPanel>
        </Link>
    );
}

const features = [
    {
        icon: ScanText,
        title: "OCR Local - TrOCR Fine-tuned",
        badge: "WebGPU",
        description: "Modèles spécialisés Base et Large, fine-tunés sur la typographie manga et accélérés via WebGPU.",
        details: ["TrOCR Large", "SSIM Patch", "2.3s @ 1080p", "Split Multi-stage", "CER 1.62%", "RTF 0.81x"],
    },
    {
        icon: Zap,
        title: "OCR Poneglyph & Surya + Modèle Local",
        badge: "Multi-Desktop",
        description: "Deux familles de modèles bbox full-page tournent sur Modal GPU L4 ou en local via l'application desktop.",
        details: ["CER < 0.1%", "GPU L4", "95% OCR local", "5-15s / page"],
    },
    {
        icon: Cpu,
        title: "Application Desktop - Tauri v2",
        badge: "Windows",
        description: "Shell Rust, backend Python local et modèles téléchargeables pour lancer l'OCR GPU sur 127.0.0.1.",
        details: ["Rust / Tauri v2", "FastAPI local", "4 modèles locaux", "CUDA / ROC / CPU"],
    },
    {
        icon: Boxes,
        title: "Détection de Bulles - YOLO26",
        badge: "ONNX",
        description: "YOLO26n fine-tuné isole chaque zone de texte côté client via ONNX Runtime Web.",
        details: ["2.4M params", "mAP50 0.994", "ONNX", "2.2s @ 1080p", "5.2 GFLOPs"],
    },
    {
        icon: Layers,
        title: "Tri One-Shot - ONNX",
        badge: "v3",
        description: "Deux rankers ordonnent les cases puis les bulles dans le contexte, sans serveur et en Web Worker.",
        details: ["gemma3_context.onnx", "bubble_order.onnx", "93.75% page exact", "Mini Worker"],
    },
    {
        icon: Search,
        title: "Recherche Sémantique & Indexation",
        badge: "pgvector",
        description: "Architecture hybride avec embeddings, consensus scoring et stockage vectoriel pour retrouver une scène depuis une description.",
        details: ["voyage-4-large", "gemini-embedding", "pgvector"],
    },
];

export default function LandingPageClient({ mangas = [] }) {
    const visibleMangas = Array.isArray(mangas) ? mangas.slice(0, 3) : [];

    return (
        <main className="min-h-screen overflow-hidden bg-[#030a13] text-white">
            <header className="sticky top-0 z-50 border-b border-white/8 bg-[#040b14]/76 backdrop-blur-xl">
                <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
                    <a href="#" className="group flex items-center gap-3">
                        <Image src="/favicon-96x96.png" alt="Logo Projet Poneglyph" width={34} height={34} className="rounded-md transition duration-200 group-hover:scale-105" />
                        <span className="text-base font-semibold tracking-tight text-white sm:text-lg">Projet Poneglyph</span>
                    </a>
                    <nav className="hidden items-center gap-8 text-sm font-medium text-slate-300 md:flex">
                        <a href="#features" className="transition hover:text-white">Fonctionnalités</a>
                        <a href="#mangas" className="transition hover:text-white">Mangas</a>
                        <Link href="/sandbox" className="flex items-center gap-2 rounded-full border border-[#6da7ff]/30 bg-[#6da7ff]/10 px-3 py-1.5 text-[#bdd6ff] transition hover:bg-[#6da7ff]/18">
                            <Cpu size={14} />
                            Sandbox
                        </Link>
                        <a href="#about" className="transition hover:text-white">À propos</a>
                    </nav>
                </div>
            </header>

            <section className="relative border-b border-white/8">
                <Image
                    src="/landing/poneglyph-hero-bg.png"
                    alt=""
                    fill
                    priority
                    sizes="100vw"
                    className="object-cover object-center"
                />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_45%_25%,rgba(61,134,255,0.14),transparent_33%),linear-gradient(90deg,rgba(3,10,19,0.2),rgba(3,10,19,0.28)_38%,rgba(3,10,19,0.78)_78%),linear-gradient(180deg,rgba(3,10,19,0.14),#030a13_96%)]" />
                <PoneglyphGlyphs count={18} seed={7} />
                <div className="relative mx-auto max-w-7xl px-5 pb-16 pt-14 sm:px-8 md:pt-20 lg:pb-20">
                    <div className="mx-auto max-w-4xl text-center">
                        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/12 bg-[#071625]/62 px-4 py-1.5 text-xs font-medium text-slate-300 backdrop-blur-md">
                            <Heart size={14} className="text-[#6da7ff]" fill="currentColor" />
                            Projet communautaire & open-source
                        </div>
                        <h1 className="text-[clamp(2.7rem,8vw,5.65rem)] font-black leading-[0.96] tracking-tight text-white">
                            Retrouvez
                            <br />
                            <span className="bg-gradient-to-b from-white via-[#8dbbff] to-[#3d86ff] bg-clip-text text-transparent drop-shadow-[0_0_22px_rgba(61,134,255,0.35)]">
                                instantanément
                            </span>
                            <br />
                            la page que vous cherchez
                        </h1>
                        <p className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-slate-200/86 sm:text-lg">
                            Une citation ? Un combat ? Un moment émouvant ? Décrivez ce que vous cherchez et trouvez la bonne page, sans avoir à feuilleter des dizaines de tomes.
                        </p>
                        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                            <a href="#mangas" className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-[#8dbbff]/35 bg-[#3d86ff] px-7 text-sm font-semibold text-white shadow-[0_16px_40px_rgba(61,134,255,0.35)] transition hover:-translate-y-0.5 hover:bg-[#2f73dc]">
                                Explorer les mangas <ArrowRight size={16} />
                            </a>
                            <a href="#features" className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-white/16 bg-[#071625]/58 px-7 text-sm font-semibold text-slate-200 backdrop-blur-md transition hover:-translate-y-0.5 hover:border-white/28 hover:bg-white/8">
                                <PlayCircle size={16} />
                                Découvrir le projet
                            </a>
                        </div>
                    </div>
                </div>
            </section>

            <section id="features" className="relative py-16 sm:py-20">
                <Image
                    src="/landing/poneglyph-section-bg.png"
                    alt=""
                    fill
                    sizes="100vw"
                    className="object-cover opacity-55"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,#030a13_0%,rgba(3,10,19,0.86)_22%,rgba(3,10,19,0.92)_100%)]" />
                <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="mx-auto mb-10 max-w-3xl text-center">
                        <div className="mb-3 inline-flex items-center gap-2 text-[#9fc5ff]">
                            <Sparkles size={17} fill="currentColor" />
                        </div>
                        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Architecture & Technologies</h2>
                        <p className="mt-3 text-sm leading-relaxed text-slate-300 sm:text-base">
                            Une infrastructure hybride WebGPU, modèles locaux et desktop Tauri pour des recherches rapides, précises et respectueuses de la confidentialité.
                        </p>
                    </div>
                    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                        {features.map((feature, i) => (
                            <FeatureCard key={feature.title} {...feature} delay={i * 70} />
                        ))}
                    </div>

                    <GlassPanel className="mt-6 grid gap-6 p-5 md:grid-cols-[1fr_auto] md:items-center md:p-7">
                        <div className="min-w-0">
                            <span className="mb-3 inline-flex rounded-md border border-[#8dbbff]/25 bg-[#8dbbff]/12 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#bdd6ff]">
                                Démonstration technique
                            </span>
                            <h3 className="text-2xl font-bold text-white">Testez l&apos;annotation en local</h3>
                            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">
                                La Sandbox permet d&apos;uploader vos propres images et de tester la détection de bulles, la transcription OCR et l&apos;inférence WebGPU sans compte ni installation.
                            </p>
                        </div>
                        <Link href="/sandbox" className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-[#8dbbff]/35 bg-[#3d86ff] px-7 text-sm font-semibold text-white shadow-[0_16px_40px_rgba(61,134,255,0.3)] transition hover:-translate-y-0.5 hover:bg-[#2f73dc]">
                            Ouvrir la Sandbox <ArrowRight size={16} />
                        </Link>
                    </GlassPanel>
                </div>
            </section>

            <section id="mangas" className="relative py-14 sm:py-18">
                <div className="absolute inset-0 bg-[#030a13]" />
                <Image
                    src="/landing/poneglyph-section-bg.png"
                    alt=""
                    fill
                    sizes="100vw"
                    className="object-cover opacity-42"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,10,19,0.94),rgba(3,10,19,0.88)_45%,#030a13)]" />
                <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
                    <div className="mb-9 text-center">
                        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Mangas disponibles</h2>
                        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">
                            Choisissez un manga pour accéder à son index, contribuer aux annotations ou lancer une recherche.
                        </p>
                    </div>

                    {visibleMangas.length === 0 ? (
                        <GlassPanel className="mx-auto max-w-xl p-10 text-center text-slate-300">
                            Aucun manga disponible.
                        </GlassPanel>
                    ) : (
                        <div className="grid gap-5 lg:grid-cols-2">
                            {visibleMangas.map((manga, i) => (
                                <MangaCard key={manga.id || manga.slug} manga={manga} index={i} />
                            ))}
                            <GlassPanel className="flex min-h-[220px] flex-col items-center justify-center border-dashed border-white/22 p-8 text-center">
                                <BookOpen className="mb-4 text-slate-400" size={42} />
                                <h3 className="text-xl font-semibold text-white">Bientôt plus...</h3>
                                <p className="mt-2 max-w-xs text-sm leading-relaxed text-slate-300">
                                    D&apos;autres mangas seront ajoutés prochainement.
                                </p>
                            </GlassPanel>
                        </div>
                    )}
                </div>
            </section>

            <section id="about" className="relative px-5 py-8 sm:px-8 sm:py-12">
                <GlassPanel className="mx-auto grid max-w-6xl gap-6 overflow-hidden p-6 md:grid-cols-[1fr_0.9fr] md:p-8">
                    <div className="flex gap-5">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#8dbbff]/35 bg-[#3d86ff]/20 text-[#bdd6ff] shadow-[0_0_30px_rgba(61,134,255,0.35)]">
                            <Heart size={20} fill="currentColor" />
                        </div>
                        <div>
                            <h2 className="text-3xl font-bold tracking-tight text-white">Un projet communautaire</h2>
                            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
                                Projet Poneglyph est un outil open-source conçu pour les passionnés de manga. Grâce à l&apos;intelligence artificielle et à la contribution de sa communauté, chaque page est transcrite, indexée et rendue recherchable.
                            </p>
                        </div>
                    </div>
                    <div className="rounded-lg border border-white/12 bg-white/[0.055] p-4">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                            <Info size={16} className="text-[#8dbbff]" />
                            Démonstration technique
                        </div>
                        <p className="text-xs leading-relaxed text-slate-300">
                            Ce projet est une démonstration éducative et de recherche. Les dégradations volontaires d&apos;images publiques protègent l&apos;expérience originale et toutes les images restent la propriété de leurs ayants droit respectifs.
                        </p>
                    </div>
                </GlassPanel>
            </section>

            <footer className="border-t border-white/8 bg-[#02070d] px-5 py-10 sm:px-8">
                <div className="mx-auto grid max-w-6xl gap-8 text-sm text-slate-400 md:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
                    <div>
                        <div className="flex items-center gap-3">
                            <Image src="/favicon-96x96.png" alt="Logo Projet Poneglyph" width={30} height={30} />
                            <span className="font-semibold text-white">Projet Poneglyph</span>
                        </div>
                        <p className="mt-3 max-w-xs text-xs leading-relaxed">
                            Votre passage vers les trésors cachés de chaque page de manga.
                        </p>
                    </div>
                    <div>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-300">Explorer</h3>
                        <div className="flex flex-col gap-2">
                            <a href="#mangas" className="transition hover:text-white">Mangas</a>
                            <Link href="/sandbox" className="transition hover:text-white">Sandbox</Link>
                        </div>
                    </div>
                    <div>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-300">Ressources</h3>
                        <div className="flex flex-col gap-2">
                            <a href="#features" className="transition hover:text-white">Fonctionnalités</a>
                            <a href="#about" className="transition hover:text-white">À propos</a>
                        </div>
                    </div>
                    <div>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-300">Suivez le projet</h3>
                        <div className="flex gap-3">
                            {[Github, MessageCircle, ShieldCheck, Mail].map((Icon, i) => (
                                <span key={i} className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.055] text-slate-300">
                                    <Icon size={16} />
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="mx-auto mt-8 flex max-w-6xl flex-col gap-2 border-t border-white/8 pt-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                    <span>© 2024 Projet Poneglyph - Licence MIT</span>
                    <span className="max-w-xl leading-relaxed sm:text-right">
                        Merci à <em>Chip Huyen</em> pour <em>AI Engineering</em> (O&apos;Reilly, 2025), source d&apos;inspiration majeure pour l&apos;orchestration et l&apos;infrastructure hybride de ce projet.
                    </span>
                </div>
            </footer>
        </main>
    );
}
