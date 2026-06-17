"use client";

import React, { useState, useEffect, Suspense } from 'react';
import AddTomeForm from '@/components/AddTomeForm';
import AddChapterForm from '@/components/AddChapterForm';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
    Zap
} from "lucide-react";

import { useSearchParams, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { getAllMangas, toggleMangaEnabled } from '@/lib/api';

const IpBanManager = React.lazy(() => import('@/components/IpBanManager'));
const CoverManager = React.lazy(() => import('@/components/CoverManager'));
const AiModelManager = React.lazy(() => import('@/components/AiModelManager'));

function TabSkeleton() {
    return (
        <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin border-2 border-slate-200 border-t-indigo-600 rounded-full" />
        </div>
    );
}

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

    return (
        <div className="container mx-auto max-w-5xl space-y-8 px-4 py-10 animate-in fade-in slide-in-from-bottom-4 duration-500">

            <div className="flex flex-col space-y-2 border-b border-white/10 pb-8">
                <h1 className="poneglyph-title text-4xl font-extrabold">
                    Administration
                </h1>
                <p className="poneglyph-muted max-w-2xl text-lg">
                    Gérez votre bibliothèque de mangas, supervisez la sécurité et configurez les outils linguistiques.
                </p>
            </div>

            <Tabs value={currentTab} onValueChange={(val) => {
                const params = new URLSearchParams(searchParams);
                params.set('tab', val);
                window.history.pushState(null, '', `?${params.toString()}`);
            }} className="w-full">
                <div className="sticky top-16 z-20 bg-[#06111e]/86 pb-6 pt-2 backdrop-blur-xl">
                    <TabsList className="grid h-auto w-full grid-cols-2 border border-white/12 bg-white/8 p-1 lg:grid-cols-6">
                        <TabsTrigger value="content" className="px-4 py-3 text-slate-300 transition-all data-[state=active]:bg-white/12 data-[state=active]:text-white data-[state=active]:shadow-sm focus-visible:ring-0">
                            <Library className="h-4 w-4 mr-2" />
                            <span className="font-medium">Bibliothèque</span>
                        </TabsTrigger>
                        <TabsTrigger value="mangas" className="px-4 py-3 text-slate-300 transition-all data-[state=active]:bg-white/12 data-[state=active]:text-white data-[state=active]:shadow-sm focus-visible:ring-0">
                            <BookOpen className="h-4 w-4 mr-2" />
                            <span className="font-medium">Mangas</span>
                        </TabsTrigger>
                        <TabsTrigger value="covers" className="px-4 py-3 text-slate-300 transition-all data-[state=active]:bg-white/12 data-[state=active]:text-white data-[state=active]:shadow-sm focus-visible:ring-0">
                            <ImageIcon className="h-4 w-4 mr-2" />
                            <span className="font-medium">Apparence</span>
                        </TabsTrigger>
                        <TabsTrigger value="ai" className="px-4 py-3 text-slate-300 transition-all data-[state=active]:bg-white/12 data-[state=active]:text-white data-[state=active]:shadow-sm focus-visible:ring-0">
                            <Cpu className="h-4 w-4 mr-2" />
                            <span className="font-medium">IA</span>
                        </TabsTrigger>
                        <TabsTrigger value="security" className="px-4 py-3 text-red-300 transition-all data-[state=active]:bg-red-500/14 data-[state=active]:text-red-100 data-[state=active]:shadow-sm focus-visible:ring-0">
                            <ShieldAlert className="h-4 w-4 mr-2" />
                            <span className="font-medium">Sécurité</span>
                        </TabsTrigger>
                        <TabsTrigger value="batch" className="px-4 py-3 text-[#8dbbff] transition-all data-[state=active]:bg-[#3d86ff]/16 data-[state=active]:text-white data-[state=active]:shadow-sm focus-visible:ring-0">
                            <Zap className="h-4 w-4 mr-2" />
                            <span className="font-medium">Batch OCR</span>
                        </TabsTrigger>
                    </TabsList>
                </div>

                <div className="poneglyph-panel mt-2 min-h-[600px] overflow-hidden rounded-3xl">
                    <TabsContent value="content" className="m-0 p-8 space-y-12 outline-none">
                        <AddTomeForm />
                        <div className="mx-4 h-px bg-white/10" />
                        <AddChapterForm />
                        <div className="mx-4 h-px bg-white/10" />
                        <div className="flex items-center justify-between rounded-xl border border-[#8dbbff]/18 bg-[#071625]/78 p-6 shadow-[0_18px_48px_rgba(0,0,0,0.22)]">
                            <div>
                                <h3 className="flex items-center gap-2 text-lg font-bold text-white">
                                    <Upload className="h-5 w-5 text-[#8dbbff]" />
                                    Upload Tome complet
                                </h3>
                                <p className="mt-1 text-sm text-slate-400">
                                    Importez un CBZ, organisez les pages et assignez-les à des chapitres.
                                </p>
                            </div>
                            <Link href={`/${params.mangaSlug}/admin/upload-tome`}>
                                <Button className="border border-[#8dbbff]/35 bg-[#3d86ff] text-white shadow-[0_14px_34px_rgba(61,134,255,0.28)] hover:bg-[#2f73dc]">
                                    <Upload className="h-4 w-4 mr-2" />
                                    Ouvrir
                                </Button>
                            </Link>
                        </div>
                    </TabsContent>

                    <TabsContent value="mangas" className="m-0 p-8 outline-none">
                        <Card className="border-slate-200">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <BookOpen className="h-5 w-5 text-indigo-600" />
                                    Visibilité des Mangas
                                </CardTitle>
                                <CardDescription>
                                    Activez ou désactivez les mangas. Un manga désactivé est invisible pour les utilisateurs.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-2">
                                {mangasLoading ? (
                                    <div className="flex justify-center py-8">
                                        <div className="h-6 w-6 animate-spin border-2 border-slate-200 border-t-indigo-600 rounded-full" />
                                    </div>
                                ) : mangas.length === 0 ? (
                                    <p className="text-sm text-slate-500 text-center py-4">Aucun manga trouvé.</p>
                                ) : (
                                    mangas.map(manga => (
                                        <div key={manga.id} className={`flex items-center justify-between p-4 rounded-xl border transition-all ${manga.enabled ? 'border-slate-200 bg-white' : 'border-red-100 bg-red-50/50'}`}>
                                            <div className="flex items-center gap-3">
                                                {manga.cover_url ? (
                                                    <img src={manga.cover_url} alt={manga.titre} className="h-12 w-9 object-cover rounded-md border border-slate-200" />
                                                ) : (
                                                    <div className="h-12 w-9 rounded-md bg-slate-100 flex items-center justify-center">
                                                        <BookOpen className="h-4 w-4 text-slate-400" />
                                                    </div>
                                                )}
                                                <div>
                                                    <p className="font-semibold text-slate-900">{manga.titre}</p>
                                                    <p className="text-xs text-slate-500">/{manga.slug}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <span className={`text-xs font-medium flex items-center gap-1 ${manga.enabled ? 'text-emerald-600' : 'text-red-500'}`}>
                                                    {manga.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                                    {manga.enabled ? 'Visible' : 'Masqué'}
                                                </span>
                                                <Switch
                                                    checked={manga.enabled}
                                                    disabled={togglingId === manga.id}
                                                    onCheckedChange={() => handleToggle(manga.id)}
                                                />
                                            </div>
                                        </div>
                                    ))
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="covers" className="m-0 p-8 outline-none">
                        <Suspense fallback={<TabSkeleton />}>
                            <CoverManager />
                        </Suspense>
                    </TabsContent>


                    <TabsContent value="ai" className="m-0 p-8 outline-none">
                        <Suspense fallback={<TabSkeleton />}>
                            <AiModelManager mangaSlug={params.mangaSlug} />
                        </Suspense>
                    </TabsContent>

                    <TabsContent value="security" className="m-0 p-8 outline-none">
                        <Suspense fallback={<TabSkeleton />}>
                            <IpBanManager />
                        </Suspense>
                    </TabsContent>

                    <TabsContent value="batch" className="m-0 p-8 outline-none">
                        <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-slate-50 to-slate-100 border border-slate-200 p-6">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                                    <Zap className="h-5 w-5 text-indigo-600" />
                                    Batch OCR
                                </h3>
                                <p className="text-sm text-slate-500 mt-1">
                                    Traitez un chapitre complet automatiquement : détection YOLO, OCR Poneglyph-BBox + Poneglyph, auto-validation des concordances.
                                </p>
                            </div>
                            <Link href={`/${params.mangaSlug}/admin/batch-ocr`}>
                                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg">
                                    <Zap className="h-4 w-4 mr-2" />
                                    Ouvrir
                                </Button>
                            </Link>
                        </div>
                    </TabsContent>
                </div>
            </Tabs>

        </div >
    );
}
