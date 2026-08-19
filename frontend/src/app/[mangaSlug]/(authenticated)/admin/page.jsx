"use client";

import React, { useState, useEffect } from 'react';
import AddTomeForm from '@/components/AddTomeForm';
import AddChapterForm from '@/components/AddChapterForm';
import IpBanManager from '@/components/IpBanManager';
import CoverManager from '@/components/CoverManager';
import AiModelManager from '@/components/AiModelManager';
import TrainingJobManager from '@/components/TrainingJobManager';
import PromptManager from '@/components/PromptManager';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
    Library,
    ShieldAlert,
    Image as ImageIcon,
    Cpu,
    Upload,
    BookOpen,
    Eye,
    EyeOff,
    Zap,
    CloudLightning,
    ScrollText,
    ArrowRight,
} from "lucide-react";

import { useSearchParams, useParams } from 'next/navigation';
import Link from 'next/link';
import { getAllMangas, toggleMangaEnabled } from '@/lib/api';
import { getCoverThumbnailUrl } from '@/lib/utils';

const TABS = [
    { value: 'content', label: 'Bibliothèque', icon: Library, tint: 'text-slate-200' },
    { value: 'mangas', label: 'Mangas', icon: BookOpen, tint: 'text-slate-200' },
    { value: 'covers', label: 'Apparence', icon: ImageIcon, tint: 'text-slate-200' },
    { value: 'ai', label: 'IA', icon: Cpu, tint: 'text-slate-200' },
    { value: 'prompts', label: 'Prompts', icon: ScrollText, tint: 'text-[#8dbbff]' },
    { value: 'training', label: 'Fine-tuning', icon: CloudLightning, tint: 'text-[#8dbbff]' },
    { value: 'security', label: 'Sécurité', icon: ShieldAlert, tint: 'text-rose-300' },
    { value: 'batch', label: 'Batch OCR', icon: Zap, tint: 'text-[#8dbbff]' },
];

export default function AdminDashboard() {
    const searchParams = useSearchParams();
    const params = useParams();
    const currentTab = searchParams.get('tab') || 'content';

    const [mangas, setMangas] = useState([]);
    const [mangasLoading, setMangasLoading] = useState(false);
    const [togglingId, setTogglingId] = useState(null);

    useEffect(() => {
        if (currentTab === 'mangas') {
            setMangasLoading(true);
            getAllMangas().then(({ data }) => setMangas(data || [])).finally(() => setMangasLoading(false));
        }
    }, [currentTab]);

    const handleToggle = async (id) => {
        setTogglingId(id);
        try {
            const { data } = await toggleMangaEnabled(id);
            setMangas(prev => prev.map(m => m.id === id ? data : m));
        } catch (e) {
            console.error("Toggle error:", e);
        } finally {
            setTogglingId(null);
        }
    };

    const onTabChange = (val) => {
        const sp = new URLSearchParams(searchParams);
        sp.set('tab', val);
        window.history.pushState(null, '', `?${sp.toString()}`);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden">
            {/* Header */}
            <div className="shrink-0 border-b border-white/8 px-1 pb-6">
                <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
                        <ShieldAlert className="h-5 w-5 text-[#8dbbff]" />
                    </div>
                    <div>
                        <h1 className="poneglyph-title text-2xl font-bold tracking-tight">
                            Administration
                        </h1>
                        <p className="poneglyph-muted text-sm">
                            Bibliothèque, sécurité et outils linguistiques.
                        </p>
                    </div>
                </div>
            </div>

            <Tabs value={currentTab} onValueChange={onTabChange} className="mt-6 flex min-h-0 flex-1 flex-col gap-5">
                {/* Tab bar */}
                <div className="sticky top-0 z-20 shrink-0">
                    <TabsList className="grid h-auto w-full grid-cols-3 gap-1 rounded-2xl border border-white/10 bg-[#071625]/70 p-1.5 backdrop-blur-xl sm:grid-cols-4 lg:grid-cols-8">
                        {TABS.map(t => {
                            const Icon = t.icon;
                            return (
                                <TabsTrigger
                                    key={t.value}
                                    value={t.value}
                                    className="flex-col gap-1 rounded-xl px-2 py-2.5 text-xs font-medium outline-none focus-visible:ring-0"
                                >
                                    <Icon className={`h-4 w-4 ${t.tint}`} />
                                    <span>{t.label}</span>
                                </TabsTrigger>
                            );
                        })}
                    </TabsList>
                </div>

                {/* Scrollable content area */}
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    <TabsContent value="content" className="mt-0 outline-none">
                        <div className="grid gap-5 lg:grid-cols-2">
                            <AddTomeForm />
                            <AddChapterForm />
                        </div>
                        <LauncherCard
                            href={`/${params.mangaSlug}/admin/upload-tome`}
                            icon={Upload}
                            tint="#8dbbff"
                            title="Upload Tome complet"
                            desc="Importez un CBZ, organisez les pages et assignez-les à des chapitres en flux guidé."
                            cta="Ouvrir"
                        />
                    </TabsContent>

                    <TabsContent value="mangas" className="mt-0 outline-none">
                        <MangaVisibility
                            mangas={mangas}
                            loading={mangasLoading}
                            togglingId={togglingId}
                            onToggle={handleToggle}
                        />
                    </TabsContent>

                    <TabsContent value="covers" className="mt-0 outline-none">
                        <CoverManager />
                    </TabsContent>

                    <TabsContent value="ai" className="mt-0 outline-none">
                        <AiModelManager mangaSlug={params.mangaSlug} />
                    </TabsContent>

                    <TabsContent value="prompts" className="mt-0 outline-none">
                        <PromptManager />
                    </TabsContent>

                    <TabsContent value="training" className="mt-0 outline-none">
                        <TrainingJobManager />
                    </TabsContent>

                    <TabsContent value="security" className="mt-0 outline-none">
                        <IpBanManager />
                    </TabsContent>

                    <TabsContent value="batch" className="mt-0 outline-none">
                        <LauncherCard
                            href={`/${params.mangaSlug}/admin/batch-ocr`}
                            icon={Zap}
                            tint="#8dbbff"
                            title="Batch OCR"
                            desc="Traitez un chapitre complet automatiquement : détection YOLO, OCR Poneglyph-BBox + Poneglyph, auto-validation des concordances."
                            cta="Ouvrir"
                        />
                    </TabsContent>
                </div>
            </Tabs>
        </div>
    );
}

function LauncherCard({ href, icon: Icon, tint, title, desc, cta }) {
    return (
        <Link href={href} className="group mt-5 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md transition-all hover:border-[#8dbbff]/40 hover:bg-[#0a1d30]/80">
            <div className="flex items-start gap-4">
                <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10"
                    style={{ background: `${tint}1f`, color: tint }}
                >
                    <Icon className="h-5 w-5" />
                </div>
                <div>
                    <h3 className="font-semibold text-white">{title}</h3>
                    <p className="mt-1 max-w-xl text-sm text-slate-400">{desc}</p>
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-xl border border-[#3d86ff]/35 bg-[#3d86ff] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_34px_rgba(61,134,255,0.28)] transition-all group-hover:bg-[#2f73dc]">
                {cta}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </div>
        </Link>
    );
}

function MangaVisibility({ mangas, loading, togglingId, onToggle }) {
    return (
        <div className="rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md">
            <div className="mb-4">
                <h2 className="flex items-center gap-2 font-semibold text-white">
                    <BookOpen className="h-4 w-4 text-[#8dbbff]" />
                    Visibilité des Mangas
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                    Un manga désactivé est invisible pour les utilisateurs.
                </p>
            </div>

            <div className="space-y-2">
                {loading ? (
                    <div className="flex justify-center py-10">
                        <div className="h-7 w-7 animate-spin border-2 border-white/15 border-t-[#8dbbff] rounded-full" />
                    </div>
                ) : mangas.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-white/12 py-10 text-center text-sm text-slate-400">
                        Aucun manga trouvé.
                    </div>
                ) : (
                    mangas.map(manga => (
                        <div
                            key={manga.id}
                            className={`flex items-center justify-between rounded-xl border p-3 transition-all ${manga.enabled
                                ? 'border-white/10 bg-white/[0.04]'
                                : 'border-rose-400/25 bg-rose-500/8'
                                }`}
                        >
                            <div className="flex items-center gap-3">
                                {manga.cover_url ? (
                                    <img src={getCoverThumbnailUrl(manga.cover_url, 160)} alt={manga.titre} className="h-12 w-9 rounded-md border border-white/12 object-cover" />
                                ) : (
                                    <div className="flex h-12 w-9 items-center justify-center rounded-md border border-white/10 bg-white/[0.04]">
                                        <BookOpen className="h-4 w-4 text-slate-500" />
                                    </div>
                                )}
                                <div>
                                    <p className="font-medium text-slate-100">{manga.titre}</p>
                                    <p className="font-mono text-xs text-slate-500">/{manga.slug}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className={`flex items-center gap-1.5 text-xs font-medium ${manga.enabled ? 'text-emerald-300' : 'text-rose-300'}`}>
                                    {manga.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                    {manga.enabled ? 'Visible' : 'Masqué'}
                                </span>
                                <Switch
                                    checked={manga.enabled}
                                    disabled={togglingId === manga.id}
                                    onCheckedChange={() => onToggle(manga.id)}
                                />
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
