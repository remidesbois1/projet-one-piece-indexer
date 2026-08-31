"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { getMangaCoverThumbnailUrl } from "@/lib/utils";
import {
    ArrowRight,
    BookOpen,
    Github,
    Info,
    Mail,
    MessageCircle,
    PlayCircle,
    Search,
    ShieldCheck,
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

function MangaItem({ manga, index }) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setIsVisible(true), 120 + index * 110);
        return () => clearTimeout(timer);
    }, [index]);

    return (
        <Link
            href={`/${manga.slug}/dashboard`}
            className="grid gap-5 border-t border-white/10 py-7 transition-colors duration-200 hover:border-white/20 sm:grid-cols-[110px_1fr]"
            style={{ opacity: isVisible ? 1 : 0 }}
        >
                <div className="relative aspect-[3/4] w-[110px] overflow-hidden bg-[#0b1624]">
                    {manga.cover_url ? (
                        <Image
                            src={getMangaCoverThumbnailUrl(manga.slug, 600)}
                            alt={`Couverture du manga ${manga.titre}`}
                            fill
                            sizes="110px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="flex h-full items-center justify-center text-slate-500">
                            <BookOpen size={36} />
                        </div>
                    )}
                </div>
                <div className="flex min-w-0 flex-col justify-center">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Disponible</span>
                    <h3 className="mt-2 text-2xl font-semibold text-white">{manga.titre}</h3>
                    {(manga.total_chapitres || manga.total_tomes) && (
                        <p className="mt-2 text-xs text-slate-400">
                            {[
                                manga.total_chapitres ? `${manga.total_chapitres} chapitres` : null,
                                manga.total_tomes ? `${manga.total_tomes} tomes` : null,
                            ].filter(Boolean).join(" · ")}
                        </p>
                    )}
                    <p className="mt-3 line-clamp-3 max-w-2xl text-sm leading-relaxed text-slate-300/82">
                        {manga.description || "Un index communautaire pour retrouver les pages, les scènes et les dialogues marquants."}
                    </p>
                    <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-[#8dbbff]">
                        Explorer <ArrowRight size={15} />
                    </div>
                </div>
        </Link>
    );
}

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
                        <Link href="/sandbox" className="rounded-full border border-[#6da7ff]/30 bg-[#6da7ff]/10 px-3 py-1.5 text-[#bdd6ff] transition hover:bg-[#6da7ff]/18">
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
                <div className="relative mx-auto max-w-7xl px-5 pb-16 pt-14 sm:px-8 md:pt-20 lg:pb-24">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-[clamp(2.7rem,7.4vw,5.45rem)] font-black leading-[0.97] tracking-[-0.045em] text-white">
                            Une scène en tête ?
                        </h1>

                        <p className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-slate-200/86 sm:text-lg">
                            Décrivez simplement ce dont vous vous souvenez : une réplique, un combat, un personnage ou même une émotion. Poneglyph retrouve les pages qui correspondent, sans connaître le tome ni le chapitre.
                        </p>

                        <form action="/one-piece/search" method="get" className="mx-auto mt-9 max-w-3xl rounded-2xl border border-[#3d86ff]/25 bg-[#071625]/92 p-2 shadow-[0_24px_80px_rgba(0,0,0,0.38),0_0_45px_rgba(61,134,255,0.08)] backdrop-blur-xl">
                            <input type="hidden" name="mode" value="semantic" />
                            <div className="flex min-h-14 items-center gap-3 rounded-xl border border-[#3d86ff]/25 bg-[#071625] px-4 text-left transition focus-within:border-[#6da7ff]/55 focus-within:shadow-[0_0_0_3px_rgba(61,134,255,0.12)]">
                                <Search size={19} className="shrink-0 text-[#6da7ff]" />
                                <input
                                    name="q"
                                    required
                                    minLength={2}
                                    aria-label="Rechercher dans One Piece"
                                    placeholder="Décrivez une scène, une réplique, un personnage..."
                                    className="min-w-0 flex-1 !border-0 !bg-[#071625] text-sm text-white outline-none placeholder:text-slate-500 sm:text-base"
                                />
                                <button type="submit" className="hidden shrink-0 items-center gap-2 rounded-lg bg-[#3d86ff] px-4 py-2 text-xs font-semibold text-white shadow-[0_8px_24px_rgba(61,134,255,0.28)] transition hover:bg-[#2f73dc] sm:inline-flex">
                                    Rechercher <ArrowRight size={14} />
                                </button>
                            </div>
                            <div className="flex flex-wrap items-center justify-center gap-2 px-2 pb-1 pt-3 text-xs text-slate-400">
                                <span className="mr-1 text-slate-500">Essayez avec :</span>
                                {[
                                    'Luffy rencontre Zoro attaché à un poteau',
                                    'le combat entre Zoro et Mihawk',
                                    'Nami demande de l’aide à Luffy',
                                    'Sanji nourrit Gin au Baratie',
                                ].map((label) => (
                                    <a key={label} href={`/one-piece/search?mode=semantic&q=${encodeURIComponent(label)}`} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-slate-300 transition hover:border-[#6da7ff]/45 hover:bg-[#3d86ff]/15 hover:text-white">
                                        {label}
                                    </a>
                                ))}
                            </div>
                        </form>

                        <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                            <a href="#mangas" className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-[#8dbbff]/35 bg-[#3d86ff] px-7 text-sm font-semibold text-white shadow-[0_16px_40px_rgba(61,134,255,0.35)] transition hover:-translate-y-0.5 hover:bg-[#2f73dc]">
                                Explorer la bibliothèque <ArrowRight size={16} />
                            </a>
                            <a href="#features" className="inline-flex h-12 items-center justify-center gap-3 rounded-lg border border-white/16 bg-[#071625]/58 px-7 text-sm font-semibold text-slate-200 backdrop-blur-md transition hover:-translate-y-0.5 hover:border-white/28 hover:bg-white/8">
                                <PlayCircle size={16} />
                                Voir comment ça marche
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
                    <div className="mx-auto max-w-3xl text-center">
                        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Architecture & Technologies</h2>
                        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
                            Une partie de l&apos;OCR, de la détection et du tri s&apos;exécute directement dans le navigateur avec WebGPU et Transformers.js. Les modèles plus lourds tournent sur GPU local ou dans le cloud, avec Tauri pour l&apos;application desktop. Les pages et leurs contenus sont ensuite indexés pour permettre une recherche rapide en langage naturel.
                        </p>
                        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-slate-400">
                            <span>WebGPU</span>
                            <span aria-hidden="true">·</span>
                            <span>ONNX</span>
                            <span aria-hidden="true">·</span>
                            <span>Tauri</span>
                            <span aria-hidden="true">·</span>
                            <span>GPU local / cloud</span>
                            <span aria-hidden="true">·</span>
                            <span>pgvector</span>
                        </div>
                        <Link href="/sandbox" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[#8dbbff] transition-colors hover:text-[#bdd6ff]">
                            Tester la Sandbox <ArrowRight size={15} />
                        </Link>
                    </div>
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
                        <div className="mx-auto max-w-xl border-y border-white/10 py-10 text-center text-slate-300">
                            Aucun manga disponible.
                        </div>
                    ) : (
                        <div className="mx-auto max-w-4xl">
                            {visibleMangas.map((manga, i) => (
                                <MangaItem key={manga.id || manga.slug} manga={manga} index={i} />
                            ))}
                            <div className="flex items-start gap-4 border-t border-white/10 py-7 text-left">
                                <BookOpen className="mt-0.5 shrink-0 text-slate-400" size={28} />
                                <div>
                                    <h3 className="text-lg font-semibold text-white">Bientôt plus...</h3>
                                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-slate-300">
                                        D&apos;autres mangas seront ajoutés prochainement.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </section>

            <section id="about" className="relative px-5 py-8 sm:px-8 sm:py-12">
                <div className="mx-auto grid max-w-6xl gap-8 border-y border-white/10 py-8 md:grid-cols-[1fr_0.9fr]">
                    <div className="flex gap-5">
                        <div>
                            <h2 className="text-3xl font-bold tracking-tight text-white">Un projet communautaire</h2>
                            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
                                Projet Poneglyph est un outil open-source conçu pour les passionnés de manga. Grâce à l&apos;intelligence artificielle et à la contribution de sa communauté, chaque page est transcrite, indexée et rendue recherchable.
                            </p>
                        </div>
                    </div>
                    <div className="border-l border-white/10 pl-5 md:self-center">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                            <Info size={16} className="text-[#8dbbff]" />
                            Démonstration technique
                        </div>
                        <p className="text-xs leading-relaxed text-slate-300">
                            Ce projet est une démonstration éducative et de recherche. Les dégradations volontaires d&apos;images publiques protègent l&apos;expérience originale et toutes les images restent la propriété de leurs ayants droit respectifs.
                        </p>
                    </div>
                </div>
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
