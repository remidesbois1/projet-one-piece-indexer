"use client";

import React, { useState, useEffect, useRef } from 'react';
import { getAiModels, updateAiModels, getAvailableAiModels, getEmbeddingStats, triggerGeminiBackfill, triggerVoyageBackfill, savePageData, generateVoyageEmbedding } from '@/lib/api';
import { invalidateModelCache, generatePageDescription, generateGeminiEmbedding } from '@/lib/geminiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Loader2, Save, RotateCcw, Cpu, Eye, MessageSquareText, Sparkles, Search, Zap, Play, Square, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { cn, loadImage, getProxiedImageUrl } from '@/lib/utils';

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

export default function AiModelManager({ mangaSlug }) {
    const [models, setModels] = useState(null);
    const [draft, setDraft] = useState(null);
    const [availableModels, setAvailableModels] = useState([]);
    const [embeddingStats, setEmbeddingStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingStats, setLoadingStats] = useState(true);
    const [saving, setSaving] = useState(false);
    const [triggeringGeminiBackfill, setTriggeringGeminiBackfill] = useState(false);
    const [triggeringVoyageBackfill, setTriggeringVoyageBackfill] = useState(false);

    const [searchQuery, setSearchQuery] = useState('');

    const [isBackfilling, setIsBackfilling] = useState(false);
    const [backfillProgress, setBackfillProgress] = useState({ current: 0, total: 0, log: [] });
    const shouldStopRef = useRef(false);

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
                getEmbeddingStats(mangaSlug).catch(() => ({ data: [] }))
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
            await triggerGeminiBackfill(mangaSlug);
            toast.success("Backfill Gemini multimodal démarré", { description: "Le processus génère les embeddings avec description + image. Revenez plus tard pour voir la progression." });
        } catch (error) {
            toast.error("Erreur lors du démarrage du backfill Gemini.");
        } finally {
            setTriggeringGeminiBackfill(false);
        }
    };
 
    const handleTriggerVoyageBackfill = async () => {
        setTriggeringVoyageBackfill(true);
        try {
            await triggerVoyageBackfill(mangaSlug);
            toast.success("Backfill Voyage démarré", { description: "Le processus tourne en arrière-plan. Revenez plus tard." });
        } catch (error) {
            toast.error("Erreur lors du démarrage du backfill Voyage.");
        } finally {
            setTriggeringVoyageBackfill(false);
        }
    };
    const handleClientBackfill = async () => {
        const apiKey = localStorage.getItem('google_api_key');
        if (!apiKey) {
            toast.error("Clé API Google manquante.", { description: "Veuillez configurer votre clé API Gemini dans le profil (en haut à droite) avant de lancer le backfill client." });
            return;
        }

        const pagesToProcess = embeddingStats.filter(s => !s.has_description || !s.has_voyage || !s.has_gemini);
        if (pagesToProcess.length === 0) {
            toast.info("Toutes les pages sont déjà à jour !");
            return;
        }

        setIsBackfilling(true);
        shouldStopRef.current = false;
        setBackfillProgress({ current: 0, total: pagesToProcess.length, log: ["Démarrage du backfill client..."] });

        let currentCount = 0;

        for (const page of pagesToProcess) {
            if (shouldStopRef.current) {
               setBackfillProgress(prev => ({ ...prev, log: ["Arrêt demandé par l'utilisateur.", ...prev.log] }));
               break;
            }

            try {
                setBackfillProgress(prev => ({ ...prev, current: currentCount, log: [`Traitement page ${page.id}...`, ...prev.log.slice(0, 10)] }));
                
                // 1. Charger l'image avec proxy pour éviter CORS
                const proxiedUrl = getProxiedImageUrl(page.url_image);
                const img = await loadImage(proxiedUrl);
                
                let currentDescription = page.description;
                let currentVoyage = page.has_voyage ? null : undefined; // undefined means don't update if already there
                let currentGeminiEmb = page.has_gemini ? null : undefined;

                // 2. Générer description si manquante
                if (!page.has_description) {
                    const descRes = await generatePageDescription(img, apiKey);
                    currentDescription = JSON.stringify(descRes.data);
                    setBackfillProgress(prev => ({ ...prev, log: [`Description générée pour ${page.id}`, ...prev.log.slice(0, 10)] }));
                }

                // 3. Vectoriser Voyage (via serveur mais déclenché ici pour chaque page)
                if (!page.has_voyage) {
                    // Extract text content from description
                    let text = "";
                    try {
                        const d = JSON.parse(currentDescription);
                        text = d.content || "";
                        if (d.metadata?.characters) text += " " + d.metadata.characters.join(" ");
                    } catch(e) { text = typeof currentDescription === 'string' ? currentDescription : ""; }
                    
                    if (text && text.trim()) {
                        const voyRes = await generateVoyageEmbedding(text.trim());
                        currentVoyage = voyRes.data.embedding;
                        setBackfillProgress(prev => ({ ...prev, log: [`Embedding Voyage généré pour ${page.id}`, ...prev.log.slice(0, 10)] }));
                    }
                }

                // 4. Vectoriser Gemini (Client)
                if (!page.has_gemini) {
                     let text = "";
                     try {
                         const d = JSON.parse(currentDescription);
                         text = d.content || "";
                         if (d.metadata?.characters) text += " " + d.metadata.characters.join(" ");
                     } catch(e) { text = typeof currentDescription === 'string' ? currentDescription : ""; }
                     
                     if (text && text.trim()) {
                        const gemRes = await generateGeminiEmbedding(text.trim(), img, apiKey);
                        currentGeminiEmb = gemRes;
                        setBackfillProgress(prev => ({ ...prev, log: [`Embedding Gemini généré pour ${page.id}`, ...prev.log.slice(0, 10)] }));
                     }
                }

                // 5. Sauvegarder
                await savePageData({
                    id_page: page.id,
                    description: currentDescription,
                    embedding_voyage: currentVoyage,
                    embedding_gemini: currentGeminiEmb
                });

                currentCount++;
                setBackfillProgress(prev => ({ ...prev, current: currentCount }));

            } catch (err) {
                console.error(`Erreur page ${page.id}:`, err);
                const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Erreur inconnue (CORS ou format)');
                setBackfillProgress(prev => ({ ...prev, log: [`Erreur page ${page.id}: ${errorMsg}`, ...prev.log.slice(0, 10)] }));
                // Continue to next page
            }
            
            // Artificial delay to play nice with rate limits
            await new Promise(r => setTimeout(r, 1000));
        }

        setIsBackfilling(false);
        toast.success("Backfill client terminé !", { description: `${currentCount} pages traitées.` });
        loadData(); // Refresh stats
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
                            Visualisez la complétion sémantique. Voyage (texte uniquement, bleu), Gemini (multimodal texte+image, jaune), Les Deux (vert), Aucun (rouge), Sans description (gris).
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
                            Générer Gemini (Multimodal)
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

                        {isBackfilling && (
                            <div className="bg-white border-2 border-indigo-100 rounded-2xl p-6 shadow-xl animate-in fade-in zoom-in duration-300">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-indigo-100 rounded-lg">
                                            <Loader2 className="h-5 w-5 text-indigo-600 animate-spin" />
                                        </div>
                                        <div>
                                            <h4 className="font-bold text-slate-900">Backfill Client en cours...</h4>
                                            <p className="text-xs text-slate-500">Utilisation de votre clé API Gemini personnelle</p>
                                        </div>
                                    </div>
                                    <Button 
                                        variant="outline" 
                                        size="sm" 
                                        onClick={() => shouldStopRef.current = true}
                                        className="text-red-600 border-red-200 hover:bg-red-50"
                                    >
                                        <Square className="h-3.5 w-3.5 mr-2" />
                                        Arrêter
                                    </Button>
                                </div>
                                
                                <div className="space-y-2">
                                    <div className="flex justify-between text-sm font-medium">
                                        <span className="text-slate-600">Progression</span>
                                        <span className="text-indigo-600">{Math.round((backfillProgress.current / backfillProgress.total) * 100)}% ({backfillProgress.current}/{backfillProgress.total})</span>
                                    </div>
                                    <Progress value={(backfillProgress.current / backfillProgress.total) * 100} className="h-3" />
                                </div>

                                <div className="mt-4 bg-slate-900 rounded-lg p-3 font-mono text-[10px] text-emerald-400 h-32 overflow-y-auto space-y-1 border border-slate-800">
                                    {backfillProgress.log.map((line, i) => (
                                        <div key={i} className={line.includes('Erreur') ? 'text-red-400' : ''}>
                                            <span className="text-slate-500 mr-2">[{new Date().toLocaleTimeString()}]</span>
                                            {line}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col gap-4">
                            {!isBackfilling && (
                                <div className="flex items-center gap-4 bg-indigo-50 border border-indigo-100 p-4 rounded-xl">
                                    <div className="flex-1">
                                        <h4 className="text-sm font-bold text-indigo-900">Backfill Manuel via Client</h4>
                                        <p className="text-xs text-indigo-700">Lancer le traitement sur les {embeddingStats.filter(s => !s.has_description || !s.has_voyage || !s.has_gemini).length} pages manquantes via votre navigateur.</p>
                                    </div>
                                    <Button 
                                        onClick={handleClientBackfill}
                                        className="bg-indigo-600 hover:bg-indigo-700 shadow-md"
                                    >
                                        <Play className="h-4 w-4 mr-2" />
                                        Lancer le Backfill Client
                                    </Button>
                                </div>
                            )}

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
                                            title={`Tome ${page.tome_numero} | Chap ${page.chapitre_numero} | Page ${page.numero}`}
                                            className={cn("w-3 h-3 rounded-sm opacity-80 hover:opacity-100 transition-opacity cursor-help", colorClass)}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
