"use client";

import React, { useState, useEffect } from 'react';
import AddTomeForm from '@/components/AddTomeForm';
import AddChapterForm from '@/components/AddChapterForm';
import GlossaryManager from '@/components/GlossaryManager';
import IpBanManager from '@/components/IpBanManager';
import CoverManager from '@/components/CoverManager';
import AiModelManager from '@/components/AiModelManager';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
    Library,
    ShieldAlert,
    Image as ImageIcon,
    Languages,
    Cpu,
    Upload,
    BookOpen,
    Eye,
    EyeOff
} from "lucide-react";

import { useSearchParams, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { getAllMangas, toggleMangaEnabled } from '@/lib/api';

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
        <div className="container max-w-5xl mx-auto py-10 px-4 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

            <div className="flex flex-col space-y-2 pb-8 border-b border-slate-200">
                <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                    Administration
                </h1>
                <p className="text-lg text-slate-500 max-w-2xl">
                    Gérez votre bibliothèque de mangas, supervisez la sécurité et configurez les outils linguistiques.
                </p>
            </div>

            <Tabs value={currentTab} onValueChange={(val) => {
                const params = new URLSearchParams(searchParams);
                params.set('tab', val);
                window.history.pushState(null, '', `?${params.toString()}`);
            }} className="w-full">
                <div className="sticky top-0 z-20 bg-white pt-2 pb-6">
                    <TabsList className="grid w-full grid-cols-2 lg:grid-cols-6 h-auto p-1 bg-slate-100/80 border border-slate-200">
                        <TabsTrigger value="content" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <Library className="h-4 w-4 mr-2" />
                            <span className="font-medium">Bibliothèque</span>
                        </TabsTrigger>
                        <TabsTrigger value="mangas" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <BookOpen className="h-4 w-4 mr-2" />
                            <span className="font-medium">Mangas</span>
                        </TabsTrigger>
                        <TabsTrigger value="covers" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <ImageIcon className="h-4 w-4 mr-2" />
                            <span className="font-medium">Apparence</span>
                        </TabsTrigger>
                        <TabsTrigger value="glossary" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <Languages className="h-4 w-4 mr-2" />
                            <span className="font-medium">Glossaire</span>
                        </TabsTrigger>
                        <TabsTrigger value="ai" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <Cpu className="h-4 w-4 mr-2" />
                            <span className="font-medium">IA</span>
                        </TabsTrigger>
                        <TabsTrigger value="security" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0 text-red-600 data-[state=active]:text-red-700">
                            <ShieldAlert className="h-4 w-4 mr-2" />
                            <span className="font-medium">Sécurité</span>
                        </TabsTrigger>
                    </TabsList>
                </div>

                <div className="mt-2 min-h-[600px] rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/50 overflow-hidden">
                    <TabsContent value="content" className="m-0 p-8 space-y-12 outline-none">
                        <AddTomeForm />
                        <div className="h-px bg-slate-200 mx-4" />
                        <AddChapterForm />
                        <div className="h-px bg-slate-200 mx-4" />
                        <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-slate-50 to-slate-100 border border-slate-200 p-6">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                                    <Upload className="h-5 w-5 text-indigo-600" />
                                    Upload Tome complet
                                </h3>
                                <p className="text-sm text-slate-500 mt-1">
                                    Importez un CBZ, organisez les pages et assignez-les à des chapitres.
                                </p>
                            </div>
                            <Link href={`/${params.mangaSlug}/admin/upload-tome`}>
                                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg">
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
                        <CoverManager />
                    </TabsContent>

                    <TabsContent value="glossary" className="m-0 p-8 outline-none">
                        <GlossaryManager />
                    </TabsContent>

                    <TabsContent value="ai" className="m-0 p-8 outline-none">
                        <AiModelManager />
                    </TabsContent>

                    <TabsContent value="security" className="m-0 p-8 outline-none">
                        <IpBanManager />
                    </TabsContent>
                </div>
            </Tabs>

        </div >
    );
}
