"use client";

import React, { useState, useEffect } from 'react';
import { getAiModels, updateAiModels, getAvailableAiModels, getEmbeddingStats, triggerGeminiBackfill, triggerVoyageBackfill, triggerNormalizeDescriptions } from '@/lib/api';
import { invalidateModelCache } from '@/lib/geminiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, RotateCcw, Cpu, Eye, MessageSquareText, Sparkles, Search, Zap } from 'lucide-react';
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
    const [embeddingStats, setEmbeddingStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingStats, setLoadingStats] = useState(true);
    const [saving, setSaving] = useState(false);
    const [triggeringGeminiBackfill, setTriggeringGeminiBackfill] = useState(false);
    const [triggeringVoyageBackfill, setTriggeringVoyageBackfill] = useState(false);
    const [triggeringNormalize, setTriggeringNormalize] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        setLoadingStats(true);
        try {
            const [settingsRes, availableRes, statsRes] = await Promise.all([
                getAiModels(),
                getAvailableAiModels(),
                getEmbeddingStats().catch(() => ({ data: [] }))
            ]);
            setModels(settingsRes.data);
            setDraft(settingsRes.data);
            setAvailableModels(availableRes.data);
            setEmbeddingStats(statsRes.data);
        } catch (error) {
            toast.error("Erreur lors du chargement des modèles IA.");
        } finally {
            setLoading(false);
            setLoadingStats(false);
        }
    };

    const hasChanges = models && draft && (
        models.model_ocr !== draft.model_ocr ||
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

    const handleTriggerGeminiBackfill = async () => {
        setTriggeringGeminiBackfill(true);
        try {
            await triggerGeminiBackfill();
            toast.success("Backfill Gemini démarré", { description: "Le processus tourne en arrière-plan. Revenez plus tard pour voir la progression." });
        } catch (error) {
            toast.error("Erreur lors du démarrage du backfill Gemini.");
        } finally {
            setTriggeringGeminiBackfill(false);
        }
    };

    const handleTriggerVoyageBackfill = async () => {
        setTriggeringVoyageBackfill(true);
        try {
            await triggerVoyageBackfill();
            toast.success("Backfill Voyage démarré", { description: "Le processus tourne en arrière-plan. Revenez plus tard." });
        } catch (error) {
            toast.error("Erreur lors du démarrage du backfill Voyage.");
        } finally {
            setTriggeringVoyageBackfill(false);
        }
    };

    const handleTriggerNormalize = async () => {
        const geminiKey = typeof window !== 'undefined' ? localStorage.getItem('google_api_key') : null;
        if (!geminiKey) {
            toast.error("Clé API Gemini requise", { description: "Configurez votre clé dans la page de recherche avant d'utiliser cette fonctionnalité." });
            return;
        }
        setTriggeringNormalize(true);
        try {
            await triggerNormalizeDescriptions();
            toast.success("Normalisation démarrée", { description: "Les noms de personnages sont en cours de normalisation et les embeddings seront régénérés. Suivez la progression dans la console serveur." });
        } catch (error) {
            toast.error("Erreur lors du démarrage de la normalisation.");
        } finally {
            setTriggeringNormalize(false);
        }
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
                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => setDraft(prev => ({ ...prev, [role.key]: m.id }))}
                                            title={`${m.displayName || m.id}${m.description ? `\n${m.description}` : ''}`}
                                            className={cn(
                                                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border inline-flex items-center gap-1.5",
                                                isActive
                                                    ? `${colors.activeBg} ${colors.activeText} border-transparent shadow-sm`
                                                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:shadow-sm'
                                            )}
                                        >
                                            {m.id}
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


            <div className="pt-8 border-t border-slate-200 mt-12">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                    <div>
                        <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                            <Sparkles className="h-5 w-5 text-indigo-600" />
                            État des Embeddings
                        </h2>
                        <p className="text-sm text-slate-500 mt-1">
                            Visualisez la complétion sémantique. Grise (Pas de description), Voyage (Bleu), Gemini (Jaune), Les Deux (Vert), Aucun (Rouge).
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 w-full sm:w-auto mt-2 sm:mt-0">
                        <Button
                            onClick={handleTriggerVoyageBackfill}
                            disabled={triggeringVoyageBackfill || loadingStats}
                            variant="outline"
                            className="text-slate-700 bg-white"
                        >
                            {triggeringVoyageBackfill ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                            Générer Voyage
                        </Button>
                        <Button
                            onClick={handleTriggerGeminiBackfill}
                            disabled={triggeringGeminiBackfill || loadingStats}
                            className="bg-slate-900 hover:bg-slate-800 text-white"
                        >
                            {triggeringGeminiBackfill ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                            Générer Gemini
                        </Button>
                        <Button
                            onClick={handleTriggerNormalize}
                            disabled={triggeringNormalize || loadingStats}
                            className="bg-red-600 hover:bg-red-700 text-white"
                        >
                            {triggeringNormalize ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
                            Normaliser + Re-embed
                        </Button>
                    </div>
                </div>

                {loadingStats ? (
                    <div className="flex justify-center py-10">
                        <Loader2 className="animate-spin h-6 w-6 text-slate-400" />
                    </div>
                ) : !embeddingStats || embeddingStats.length === 0 ? (
                    <div className="text-center py-10 text-slate-500 text-sm bg-slate-50 rounded-xl border border-slate-100">
                        Aucune donnée d'embedding trouvée.
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="flex flex-wrap gap-4 text-sm mb-4 bg-white p-4 rounded-xl border shadow-sm">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded bg-blue-500"></div>
                                <span className="text-slate-600">Voyage: <span className="font-semibold text-slate-900">{embeddingStats.filter(s => s.has_description && s.has_voyage && !s.has_gemini).length}</span></span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded bg-yellow-400"></div>
                                <span className="text-slate-600">Gemini: <span className="font-semibold text-slate-900">{embeddingStats.filter(s => s.has_description && !s.has_voyage && s.has_gemini).length}</span></span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded bg-emerald-500"></div>
                                <span className="text-slate-600">Les Deux: <span className="font-semibold text-slate-900">{embeddingStats.filter(s => s.has_description && s.has_voyage && s.has_gemini).length}</span></span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded bg-red-400"></div>
                                <span className="text-slate-600">Aucun: <span className="font-semibold text-slate-900">{embeddingStats.filter(s => s.has_description && !s.has_voyage && !s.has_gemini).length}</span></span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded bg-slate-300"></div>
                                <span className="text-slate-600">Sans description: <span className="font-semibold text-slate-900">{embeddingStats.filter(s => !s.has_description).length}</span></span>
                            </div>
                            <div className="ml-auto text-slate-500 font-medium">
                                Total: {embeddingStats.length} pages
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-1 p-4 bg-slate-50 rounded-xl border border-slate-200 max-h-[400px] overflow-y-auto">
                            {embeddingStats.map(page => {
                                let colorClass = "bg-red-400";
                                if (!page.has_description) colorClass = "bg-slate-300";
                                else if (page.has_voyage && page.has_gemini) colorClass = "bg-emerald-500";
                                else if (page.has_voyage) colorClass = "bg-blue-500";
                                else if (page.has_gemini) colorClass = "bg-yellow-400";

                                return (
                                    <div
                                        key={page.id}
                                        title={`Page ${page.id} (Tome/Chap: ${page.chapitre_id} | Num: ${page.numero})`}
                                        className={cn("w-3 h-3 rounded-sm opacity-80 hover:opacity-100 transition-opacity cursor-help", colorClass)}
                                    />
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
