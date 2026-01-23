"use client";

import React from 'react';
import BubbleReviewList from '@/components/BubbleReviewList';
import PageReviewList from '@/components/PageReviewList';

import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { ShieldCheck, MessageSquareDashed, FileCheck } from "lucide-react";

export default function ModerationPage() {
    return (
        <div className="min-h-screen">
            <div className="container max-w-7xl mx-auto py-10 px-4 sm:px-6">

                <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
                    <div className="space-y-1">
                        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
                            <ShieldCheck className="h-8 w-8 text-slate-900" />
                            Espace Modération
                        </h1>
                        <p className="text-slate-500 text-lg max-w-2xl">
                            Supervisez les contributions de la communauté. Validez les bulles individuelles ou approuvez les pages finales.
                        </p>
                    </div>
                </div>

                <Tabs defaultValue="bubbles" className="w-full space-y-6">

                    <div className="bg-white p-1 rounded-xl border border-slate-200 w-fit shadow-sm">
                        <TabsList className="grid w-full grid-cols-2 h-10 bg-slate-100/50">
                            <TabsTrigger
                                value="bubbles"
                                className="data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-slate-900 px-6 gap-2"
                            >
                                <MessageSquareDashed className="h-4 w-4" />
                                Bulles à valider
                            </TabsTrigger>
                            <TabsTrigger
                                value="pages"
                                className="data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-slate-900 px-6 gap-2"
                            >
                                <FileCheck className="h-4 w-4" />
                                Pages complètes
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="bubbles" className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <Card className="border-none shadow-none bg-transparent">
                            <BubbleReviewList />
                        </Card>
                    </TabsContent>

                    <TabsContent value="pages" className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <Card className="border-none shadow-none bg-transparent">
                            <PageReviewList />
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
