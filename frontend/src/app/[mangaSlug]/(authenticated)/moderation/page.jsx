"use client";

import React, { Suspense } from 'react';

import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { ShieldCheck, MessageSquareDashed, FileCheck } from "lucide-react";
import { useManga } from '@/context/MangaContext';

const BubbleReviewList = React.lazy(() => import('@/components/BubbleReviewList'));
const PageReviewList = React.lazy(() => import('@/components/PageReviewList'));

function ReviewSkeleton() {
    return (
        <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin border-2 border-slate-200 border-t-slate-600 rounded-full" />
        </div>
    );
}

export default function ModerationPage() {
    const { currentManga } = useManga();
    const pageTitle = currentManga ? `Modération : ${currentManga.titre}` : "Modération";

    return (
        <div className="min-h-screen">
            {pageTitle && <title>{pageTitle}</title>}
            <div className="container max-w-7xl mx-auto py-10 px-4 sm:px-6">

                <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
                    <div className="space-y-1">
                        <h1 className="poneglyph-title flex items-center gap-3 text-3xl font-bold">
                            <ShieldCheck className="h-8 w-8 text-[#8dbbff]" />
                            Espace Modération
                        </h1>
                        <p className="poneglyph-muted max-w-2xl text-lg">
                            Supervisez les contributions de la communauté. Validez les bulles individuelles ou approuvez les pages finales.
                        </p>
                    </div>
                </div>

                <Tabs defaultValue="bubbles" className="w-full space-y-6">

                    <div className="w-fit rounded-xl border border-white/12 bg-white/8 p-1 shadow-sm">
                        <TabsList className="grid h-10 w-full grid-cols-2 bg-transparent">
                            <TabsTrigger
                                value="bubbles"
                                className="gap-2 px-6 text-slate-300 data-[state=active]:bg-white/12 data-[state=active]:text-white data-[state=active]:shadow-sm"
                            >
                                <MessageSquareDashed className="h-4 w-4" />
                                Bulles à valider
                            </TabsTrigger>
                            <TabsTrigger
                                value="pages"
                                className="gap-2 px-6 text-slate-300 data-[state=active]:bg-white/12 data-[state=active]:text-white data-[state=active]:shadow-sm"
                            >
                                <FileCheck className="h-4 w-4" />
                                Pages complètes
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="bubbles" className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <Card className="border-none shadow-none bg-transparent">
                            <Suspense fallback={<ReviewSkeleton />}>
                                <BubbleReviewList />
                            </Suspense>
                        </Card>
                    </TabsContent>

                    <TabsContent value="pages" className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <Card className="border-none shadow-none bg-transparent">
                            <Suspense fallback={<ReviewSkeleton />}>
                                <PageReviewList />
                            </Suspense>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
