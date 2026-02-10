"use client";

import React from 'react';
import AddTomeForm from '@/components/AddTomeForm';
import AddChapterForm from '@/components/AddChapterForm';
import GlossaryManager from '@/components/GlossaryManager';
import IpBanManager from '@/components/IpBanManager';
import CoverManager from '@/components/CoverManager';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    BookPlus,
    Library,
    ShieldAlert,
    Settings2,
    Image as ImageIcon,
    Languages
} from "lucide-react";

import { useSearchParams } from 'next/navigation';

export default function AdminDashboard() {
    const searchParams = useSearchParams();
    const currentTab = searchParams.get('tab') || 'content';

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
                    <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 h-auto p-1 bg-slate-100/80 border border-slate-200">
                        <TabsTrigger value="content" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <Library className="h-4 w-4 mr-2" />
                            <span className="font-medium">Bibliothèque</span>
                        </TabsTrigger>
                        <TabsTrigger value="covers" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <ImageIcon className="h-4 w-4 mr-2" />
                            <span className="font-medium">Apparence</span>
                        </TabsTrigger>
                        <TabsTrigger value="glossary" className="py-3 px-4 data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all focus-visible:ring-0">
                            <Languages className="h-4 w-4 mr-2" />
                            <span className="font-medium">Glossaire</span>
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
                    </TabsContent>

                    <TabsContent value="covers" className="m-0 p-8 outline-none">
                        <CoverManager />
                    </TabsContent>

                    <TabsContent value="glossary" className="m-0 p-8 outline-none">
                        <GlossaryManager />
                    </TabsContent>

                    <TabsContent value="security" className="m-0 p-8 outline-none">
                        <IpBanManager />
                    </TabsContent>
                </div>
            </Tabs>

        </div >
    );
}
