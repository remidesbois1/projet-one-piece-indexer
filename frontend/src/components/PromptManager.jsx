"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { getAdminPrompts, updateAdminPrompts } from '@/lib/api';
import { cachePromptContents, DEFAULT_PROMPTS } from '@/lib/promptConfig';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, RotateCcw, ScrollText, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const CATEGORY_ORDER = ['ocr', 'description', 'import', 'embedding', 'search', 'system'];
const CATEGORY_LABELS = {
    ocr: 'OCR',
    description: 'Description & Embeddings',
    import: 'Import',
    embedding: 'Embeddings',
    search: 'Recherche',
    system: 'Système',
};

export default function PromptManager() {
    const [prompts, setPrompts] = useState(null);
    const [drafts, setDrafts] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadPrompts();
    }, []);

    async function loadPrompts() {
        setLoading(true);
        try {
            const { data } = await getAdminPrompts();
            setPrompts(data);
            setDrafts(Object.fromEntries(data.map((prompt) => [prompt.key, prompt.content])));
        } catch {
            toast.error("Erreur lors du chargement des prompts.");
        } finally {
            setLoading(false);
        }
    }

    const groupedPrompts = useMemo(() => {
        if (!prompts) return [];
        return CATEGORY_ORDER
            .map((category) => ({
                category,
                prompts: prompts.filter((prompt) => prompt.category === category),
            }))
            .filter((group) => group.prompts.length > 0);
    }, [prompts]);

    const changedKeys = useMemo(
        () => (prompts || []).filter((prompt) => drafts[prompt.key] !== prompt.content).map((prompt) => prompt.key),
        [prompts, drafts]
    );

    const handleSave = async () => {
        setSaving(true);
        try {
            const payload = Object.fromEntries(changedKeys.map((key) => [key, drafts[key].trim()]));
            const { data } = await updateAdminPrompts(payload);
            setPrompts(data);
            setDrafts(Object.fromEntries(data.map((prompt) => [prompt.key, prompt.content])));
            cachePromptContents(Object.fromEntries(data.map((prompt) => [prompt.key, prompt.content])));
            toast.success("Prompts mis à jour avec succès !", {
                description: "Appliqué à tous les utilisateurs dans les 5 prochaines minutes."
            });
        } catch (error) {
            toast.error(error?.response?.data?.error || "Erreur lors de la mise à jour des prompts.");
        } finally {
            setSaving(false);
        }
    };

    const handleResetPrompt = (key) => {
        setDrafts((previous) => ({ ...previous, [key]: prompts.find((prompt) => prompt.key === key).content }));
    };

    const handleRestoreDefault = (key) => {
        setDrafts((previous) => ({ ...previous, [key]: DEFAULT_PROMPTS[key] }));
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-[#8dbbff]" />
            </div>
        );
    }

    if (!prompts) {
        return (
            <div className="py-16 text-center text-slate-400">
                <ScrollText className="mx-auto mb-3 h-10 w-10 opacity-30" />
                <p>Impossible de charger les prompts.</p>
                <p className="mt-1 text-sm">Vérifiez que la table <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">llm_prompts</code> existe.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#3d86ff]/25 bg-[#3d86ff]/12">
                        <ScrollText className="h-4 w-4 text-[#8dbbff]" />
                    </div>
                    <div>
                        <h2 className="font-semibold text-white">Prompts système</h2>
                        <p className="text-xs text-slate-400">Tous les prompts LLM centralisés, appliqués à tous les utilisateurs.</p>
                    </div>
                </div>
                {changedKeys.length > 0 && (
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={loadPrompts} disabled={saving}>
                            <RotateCcw className="mr-1 h-4 w-4" /> Annuler
                        </Button>
                        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-[#3d86ff] hover:bg-[#2f73dc]">
                            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                            Sauvegarder ({changedKeys.length})
                        </Button>
                    </div>
                )}
            </div>

            {/* Prompt groups */}
            {groupedPrompts.map(({ category, prompts: groupPrompts }) => (
                <div key={category} className="space-y-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                        {CATEGORY_LABELS[category] || category}
                        <span className="h-px flex-1 bg-white/8" />
                    </h3>
                    {groupPrompts.map((prompt) => (
                        <PromptCard
                            key={prompt.key}
                            prompt={prompt}
                            draft={drafts[prompt.key] ?? ''}
                            dirty={drafts[prompt.key] !== prompt.content}
                            onChange={(value) => setDrafts((previous) => ({ ...previous, [prompt.key]: value }))}
                            onReset={() => handleResetPrompt(prompt.key)}
                            onRestoreDefault={() => handleRestoreDefault(prompt.key)}
                        />
                    ))}
                </div>
            ))}

            {changedKeys.length > 0 && (
                <div className="flex items-center gap-3 rounded-xl border border-[#8dbbff]/30 bg-[#3d86ff]/10 p-4 text-sm text-[#bcd6ff]">
                    <div className="h-2 w-2 animate-pulse rounded-full bg-[#3d86ff]" />
                    Modifications non sauvegardées — appliquées à tous les utilisateurs après sauvegarde.
                </div>
            )}
        </div>
    );
}

function PromptCard({ prompt, draft, dirty, onChange, onReset, onRestoreDefault }) {
    const isDefault = draft === DEFAULT_PROMPTS[prompt.key];
    const charCount = draft.length;

    return (
        <div className={cn(
            'rounded-2xl border bg-[#071625]/70 p-5 backdrop-blur-md transition-colors',
            dirty ? 'border-[#8dbbff]/40' : 'border-white/10'
        )}>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold text-white">{prompt.label}</h4>
                        <Badge variant="outline" className="border-white/10 bg-white/[0.06] font-mono text-[10px] text-slate-400">
                            {prompt.key}
                        </Badge>
                        {!isDefault && (
                            <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-[10px] text-amber-300">
                                personnalisé
                            </Badge>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{prompt.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onRestoreDefault}
                        title="Restaurer le texte par défaut"
                        className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
                    >
                        Défaut
                    </Button>
                    {dirty && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onReset}
                            className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
                        >
                            <RotateCcw className="mr-1 h-3 w-3" /> Annuler
                        </Button>
                    )}
                </div>
            </div>

            <textarea
                value={draft}
                onChange={(event) => onChange(event.target.value)}
                spellCheck={false}
                rows={Math.min(20, Math.max(6, draft.split('\n').length + 1))}
                className="w-full resize-y rounded-xl border border-white/12 bg-[#020713] p-3.5 font-mono text-xs leading-relaxed text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-[#8dbbff]/50"
            />

            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                <span className="flex items-center gap-1.5">
                    {prompt.category === 'embedding' && (
                        <>
                            <AlertTriangle className="h-3 w-3 text-amber-400" />
                            Lié au modèle fine-tuné : ne modifiez pas sans ré-entraînement.
                        </>
                    )}
                </span>
                <span className={cn(charCount > 20000 && 'text-rose-400')}>
                    {charCount.toLocaleString('fr-FR')} / 20 000 caractères
                </span>
            </div>

            {prompt.updated_at && (
                <p className="mt-1 text-[11px] text-slate-600">
                    Dernière modification : {new Date(prompt.updated_at).toLocaleString('fr-FR')}
                </p>
            )}
        </div>
    );
}
