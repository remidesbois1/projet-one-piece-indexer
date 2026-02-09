"use client";

import React from 'react';
import AddTomeForm from '@/components/AddTomeForm';
import AddChapterForm from '@/components/AddChapterForm';
import GlossaryManager from '@/components/GlossaryManager';
import IpBanManager from '@/components/IpBanManager';
import { Separator } from "@/components/ui/separator";

export default function AdminDashboard() {
    return (
        <div className="container max-w-4xl mx-auto py-10 px-4 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

            <div className="flex items-center justify-between pb-6 border-b border-slate-200">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-slate-900">Administration</h1>
                    <p className="text-slate-500 mt-2">
                        Gérez ici les volumes et chapitres disponibles dans la bibliothèque.
                    </p>
                </div>
            </div>

            <section>
                <AddTomeForm />
            </section>

            <section>
                <AddChapterForm />
            </section>

            <section>
                <GlossaryManager />
            </section>

            <section>
                <IpBanManager />
            </section>

        </div>
    );
}
