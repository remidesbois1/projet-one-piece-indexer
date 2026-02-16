"use client";

import React, { useState, useEffect } from 'react';
import { getAiModels, updateAiModels, getAvailableAiModels, checkAiModelsAvailability } from '@/lib/api';
import { invalidateModelCache } from '@/lib/geminiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, RotateCcw, Cpu, Eye, MessageSquareText, Sparkles, Search, Ban, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const MODEL_ROLES = [
    {
        key: 'model_ocr',
        label: 'OCR (Cloud)',
        description: 'Transcription du texte des bulles via Gemini.',
        icon: Eye,
        color: 'blue'
    },
    {
        key: 'model_reranking',
        label: 'Reranking',
        description: 'Réordonnancement intelligent des résultats de recherche.',
        icon: Sparkles,
        color: 'amber'
    },
    {
        key: 'model_description',
        label: 'Description de page',
        description: 'Génération de descriptions JSON pour l\'indexation sémantique.',
        icon: MessageSquareText,
        color: 'emerald'
    }
];

const colorMap = {
    blue: { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-600', badge: 'bg-blue-100 text-blue-700', activeBg: 'bg-blue-600', activeText: 'text-white' },
    amber: { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-600', badge: 'bg-amber-100 text-amber-700', activeBg: 'bg-amber-600', activeText: 'text-white' },
    emerald: { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-600', badge: 'bg-emerald-100 text-emerald-700', activeBg: 'bg-emerald-600', activeText: 'text-white' },
};

export default function AiModelManager() {
    const [models, setModels] = useState(null);
    const [draft, setDraft] = useState(null);
    const [availableModels, setAvailableModels] = useState([]);
    const [availability, setAvailability] = useState(null);
    const [loading, setLoading] = useState(true);
    const [checkingAvailability, setCheckingAvailability] = useState(false);
    const [saving, setSaving] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const [settingsRes, availableRes] = await Promise.all([
                getAiModels(),
                getAvailableAiModels()
            ]);
            setModels(settingsRes.data);
            setDraft(settingsRes.data);
            setAvailableModels(availableRes.data);
        } catch (error) {
            toast.error("Erreur lors du chargement des modèles IA.");
        } finally {
            setLoading(false);
        }

        setCheckingAvailability(true);
        try {
            const res = await checkAiModelsAvailability();
            setAvailability(res.data);
        } catch {
            // silently fail
        } finally {
            setCheckingAvailability(false);
        }
    };

    const hasChanges = models && draft && (
        models.model_ocr !== draft.model_ocr ||
        models.model_reranking !== draft.model_reranking ||
        models.model_description !== draft.model_description
    );

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await updateAiModels(draft);
            setModels(res.data);
            setDraft(res.data);
            invalidateModelCache();
            toast.success("Modèles IA mis à jour avec succès !", {
                description: "Les nouveaux modèles seront appliqués à tous les utilisateurs dans les 5 prochaines minutes."
            });
        } catch (error) {
            toast.error("Erreur lors de la mise à jour.");
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => {
        setDraft(models);
    };

    const filteredModels = availableModels.filter(m =>
        !searchQuery || m.id.toLowerCase().includes(searchQuery.toLowerCase()) || m.displayName?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="animate-spin h-8 w-8 text-slate-400" />
            </div>
        );
    }

    if (!draft) {
        return (
            <div className="text-center py-16 text-slate-500">
                <Cpu className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>Impossible de charger la configuration IA.</p>
                <p className="text-sm mt-1">Vérifiez que la table <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs">app_settings</code> existe dans Supabase.</p>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
                        <Cpu className="h-6 w-6 text-indigo-600" />
                        Modèles Gemini
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">
                        Configurez quel modèle Gemini utiliser pour chaque tâche. S'applique à tous les utilisateurs.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {hasChanges && (
                        <>
                            <Button variant="ghost" size="sm" onClick={handleReset} disabled={saving}>
                                <RotateCcw className="h-4 w-4 mr-1" />
                                Annuler
                            </Button>
                            <Button size="sm" onClick={handleSave} disabled={saving} className="bg-indigo-600 hover:bg-indigo-700">
                                {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                                Sauvegarder
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {availability && (
                <div className="flex items-center gap-4 text-xs text-slate-500">
                    <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        Free Tier
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Ban className="h-3.5 w-3.5 text-red-400" />
                        Quota 0 (payant requis)
                    </div>
                    {checkingAvailability && (
                        <div className="flex items-center gap-1.5 text-slate-400">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Vérification...
                        </div>
                    )}
                </div>
            )}

            {!availability && checkingAvailability && (
                <div className="flex items-center gap-2 text-xs text-slate-400 p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Vérification de la disponibilité free tier pour chaque modèle... (peut prendre quelques secondes)
                </div>
            )}

            {availableModels.length > 10 && (
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Filtrer les modèles..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition-all"
                    />
                    {searchQuery && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                            {filteredModels.length} modèle{filteredModels.length > 1 ? 's' : ''}
                        </span>
                    )}
                </div>
            )}

            <div className="space-y-6">
                {MODEL_ROLES.map(role => {
                    const Icon = role.icon;
                    const colors = colorMap[role.color];
                    const currentValue = draft[role.key];
                    const modelsList = filteredModels.length > 0 ? filteredModels : availableModels;
                    return (
                        <div key={role.key} className={`rounded-xl border ${colors.border} ${colors.bg} p-6 transition-all`}>
                            <div className="flex items-start gap-4 mb-4">
                                <div className={`p-2.5 rounded-lg bg-white shadow-sm border ${colors.border}`}>
                                    <Icon className={`h-5 w-5 ${colors.icon}`} />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-semibold text-slate-900 text-lg">{role.label}</h3>
                                    <p className="text-sm text-slate-500 mt-0.5">{role.description}</p>
                                </div>
                                <Badge className={`${colors.badge} font-mono text-xs`}>
                                    {currentValue}
                                </Badge>
                            </div>

                            <div className="flex flex-wrap gap-2 max-h-[200px] overflow-y-auto pr-1">
                                {modelsList.map(m => {
                                    const isActive = currentValue === m.id;
                                    const freeTier = availability?.[m.id];
                                    const isUnavailable = freeTier === false;
                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => setDraft(prev => ({ ...prev, [role.key]: m.id }))}
                                            title={`${m.displayName || m.id}${isUnavailable ? ' — ⚠️ Quota 0 sur le free tier' : ''}${m.description ? `\n${m.description}` : ''}`}
                                            className={cn(
                                                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border inline-flex items-center gap-1.5",
                                                isActive
                                                    ? `${colors.activeBg} ${colors.activeText} border-transparent shadow-sm`
                                                    : isUnavailable
                                                        ? 'bg-red-50/50 text-slate-400 border-red-200/60 hover:border-red-300'
                                                        : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:shadow-sm'
                                            )}
                                        >
                                            {availability && !isActive && (
                                                freeTier === true
                                                    ? <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                                                    : freeTier === false
                                                        ? <Ban className="h-3 w-3 text-red-400 shrink-0" />
                                                        : null
                                            )}
                                            <span className={isUnavailable && !isActive ? 'line-through decoration-red-300' : ''}>
                                                {m.id}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>

            {hasChanges && (
                <div className="flex items-center gap-3 p-4 bg-indigo-50 border border-indigo-200 rounded-xl text-sm text-indigo-800">
                    <div className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                    Modifications non sauvegardées. Les changements s'appliqueront à tous les utilisateurs après sauvegarde.
                </div>
            )}
        </div>
    );
}
