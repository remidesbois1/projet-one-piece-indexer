"use client";

import React, { useState, useEffect, useRef } from 'react';
import { getAiModels, updateAiModels, getEmbeddingStats, triggerGeminiBackfill, triggerVoyageBackfill, savePageData, generateVoyageEmbedding } from '@/lib/api';
import { generatePageDescription, generateGeminiEmbedding } from '@/lib/geminiClient';
import { cacheAiModelConfig } from '@/lib/aiModelConfig';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Loader2, Save, RotateCcw, Cpu, Eye, MessageSquareText, Sparkles, Play, Square, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { cn, loadImage, getProxiedImageUrl } from '@/lib/utils';
import ModelBenchmarkRegistry from '@/components/ModelBenchmarkRegistry';

const MODEL_ROLES = [
    {
        key: 'model_ocr',
        label: 'OCR (Cloud)',
        description: 'Transcription du texte des bulles via Gemini.',
        icon: Eye,
        tint: '#8dbbff',
    },
    {
        key: 'model_description',
        label: 'Description de page',
        description: 'Descriptions JSON pour l\'indexation sémantique.',
        icon: MessageSquareText,
        tint: '#6ee7b7',
    },
];

const OPENAI_OCR_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
const GEMINI_MODELS = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
];
const GEMINI_THINKING_LEVELS = ['default', 'none', 'minimal', 'low', 'medium', 'high'];
const OPENAI_REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function ChoiceButtons({ value, options, onChange, accent = 'blue' }) {
    const activeClasses = accent === 'sky'
        ? 'border-sky-400/60 bg-sky-400/15 text-sky-100'
        : 'border-[#8dbbff]/60 bg-[#3d86ff]/20 text-[#d8e7ff]';
    return (
        <div className="flex flex-wrap gap-2">
            {options.map(option => (
                <button
                    key={option}
                    type="button"
                    onClick={() => onChange(option)}
                    className={cn(
                        'rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors',
                        value === option
                            ? activeClasses
                            : 'border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200'
                    )}
                >
                    {option === 'default' ? 'automatique' : option}
                </button>
            ))}
        </div>
    );
}

export default function AiModelManager({ mangaSlug }) {
    const [models, setModels] = useState(null);
    const [draft, setDraft] = useState(null);
    const [embeddingStats, setEmbeddingStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingStats, setLoadingStats] = useState(true);
    const [saving, setSaving] = useState(false);
    const [triggeringGeminiBackfill, setTriggeringGeminiBackfill] = useState(false);
    const [triggeringVoyageBackfill, setTriggeringVoyageBackfill] = useState(false);

    const [isBackfilling, setIsBackfilling] = useState(false);
    const [backfillProgress, setBackfillProgress] = useState({ current: 0, total: 0, log: [] });
    const shouldStopRef = useRef(false);

    useEffect(() => {
        loadData();
    }, []);

    async function loadData() {
        setLoading(true);
        setLoadingStats(true);
        const statsPromise = getEmbeddingStats(mangaSlug)
            .then(statsRes => setEmbeddingStats(statsRes.data))
            .catch(() => setEmbeddingStats([]))
            .finally(() => setLoadingStats(false));

        try {
            const settingsRes = await getAiModels();
            setModels(settingsRes.data);
            setDraft(settingsRes.data);
        } catch (error) {
            toast.error("Erreur lors du chargement des modèles IA.");
        } finally {
            setLoading(false);
        }

        await statsPromise;
    }

    const hasChanges = models && draft && (
        models.model_ocr !== draft.model_ocr ||
        models.model_description !== draft.model_description ||
        models.model_chatgpt_ocr !== draft.model_chatgpt_ocr ||
        models.gemini_thinking_level !== draft.gemini_thinking_level ||
        models.chatgpt_reasoning_effort !== draft.chatgpt_reasoning_effort ||
        models.chatgpt_fast_mode !== draft.chatgpt_fast_mode
    );

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await updateAiModels(draft);
            setModels(res.data);
            setDraft(res.data);
            cacheAiModelConfig(res.data);
            toast.success("Modèles IA mis à jour avec succès !", {
                description: "Appliqué à tous les utilisateurs dans les 5 prochaines minutes."
            });
        } catch (error) {
            toast.error("Erreur lors de la mise à jour.");
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => setDraft(models);

    const handleTriggerGeminiBackfill = async () => {
        setTriggeringGeminiBackfill(true);
        try {
            await triggerGeminiBackfill(mangaSlug);
            toast.success("Backfill Gemini multimodal démarré", { description: "Génère les embeddings description + image. Revenez plus tard." });
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
            toast.success("Backfill Voyage démarré", { description: "Tourne en arrière-plan. Revenez plus tard." });
        } catch (error) {
            toast.error("Erreur lors du démarrage du backfill Voyage.");
        } finally {
            setTriggeringVoyageBackfill(false);
        }
    };

    const handleClientBackfill = async () => {
        const apiKey = localStorage.getItem('google_api_key');
        if (!apiKey) {
            toast.error("Clé API Google manquante.", { description: "Configurez votre clé API Gemini dans le profil avant de lancer le backfill client." });
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
                setBackfillProgress(prev => ({ ...prev, log: ["Arrêt demandé.", ...prev.log] }));
                break;
            }

            try {
                setBackfillProgress(prev => ({ ...prev, current: currentCount, log: [`Traitement page ${page.id}...`, ...prev.log.slice(0, 10)] }));

                const proxiedUrl = getProxiedImageUrl(page.url_image);
                const img = await loadImage(proxiedUrl);

                let currentDescription = page.description;
                let currentVoyage = page.has_voyage ? null : undefined;
                let currentGeminiEmb = page.has_gemini ? null : undefined;

                if (!page.has_description) {
                    const descRes = await generatePageDescription(img, apiKey);
                    currentDescription = JSON.stringify(descRes.data);
                    setBackfillProgress(prev => ({ ...prev, log: [`Description générée pour ${page.id}`, ...prev.log.slice(0, 10)] }));
                }

                if (!page.has_voyage) {
                    let text = "";
                    try {
                        const d = JSON.parse(currentDescription);
                        text = d.content || "";
                        if (d.metadata?.characters) text += " " + d.metadata.characters.join(" ");
                    } catch (e) { text = typeof currentDescription === 'string' ? currentDescription : ""; }

                    if (text && text.trim()) {
                        const voyRes = await generateVoyageEmbedding(text.trim());
                        currentVoyage = voyRes.data.embedding;
                        setBackfillProgress(prev => ({ ...prev, log: [`Embedding Voyage généré pour ${page.id}`, ...prev.log.slice(0, 10)] }));
                    }
                }

                if (!page.has_gemini) {
                    let text = "";
                    try {
                        const d = JSON.parse(currentDescription);
                        text = d.content || "";
                        if (d.metadata?.characters) text += " " + d.metadata.characters.join(" ");
                    } catch (e) { text = typeof currentDescription === 'string' ? currentDescription : ""; }

                    if (text && text.trim()) {
                        const gemRes = await generateGeminiEmbedding(text.trim(), img, apiKey);
                        currentGeminiEmb = gemRes;
                        setBackfillProgress(prev => ({ ...prev, log: [`Embedding Gemini généré pour ${page.id}`, ...prev.log.slice(0, 10)] }));
                    }
                }

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
                const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Erreur inconnue');
                setBackfillProgress(prev => ({ ...prev, log: [`Erreur page ${page.id}: ${errorMsg}`, ...prev.log.slice(0, 10)] }));
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        setIsBackfilling(false);
        toast.success("Backfill client terminé !", { description: `${currentCount} pages traitées.` });
        loadData();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-[#8dbbff]" />
            </div>
        );
    }

    if (!draft) {
        return (
            <div className="py-16 text-center text-slate-400">
                <Cpu className="mx-auto mb-3 h-10 w-10 opacity-30" />
                <p>Impossible de charger la configuration IA.</p>
                <p className="mt-1 text-sm">Vérifiez que la table <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">app_settings</code> existe.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#3d86ff]/25 bg-[#3d86ff]/12">
                        <Cpu className="h-4 w-4 text-[#8dbbff]" />
                    </div>
                    <div>
                        <h2 className="font-semibold text-white">Configuration IA</h2>
                        <p className="text-xs text-slate-400">Appliqué à tous les utilisateurs.</p>
                    </div>
                </div>
                {hasChanges && (
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={handleReset} disabled={saving}>
                            <RotateCcw className="mr-1 h-4 w-4" /> Annuler
                        </Button>
                        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-[#3d86ff] hover:bg-[#2f73dc]">
                            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                            Sauvegarder
                        </Button>
                    </div>
                )}
            </div>

            {/* Role cards */}
            <div className="space-y-5">
                {MODEL_ROLES.map(role => {
                    const Icon = role.icon;
                    const currentValue = draft[role.key];
                    return (
                        <div key={role.key} className="rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md">
                            <div className="mb-4 flex items-center gap-3">
                                <div
                                    className="flex h-9 w-9 items-center justify-center rounded-lg border"
                                    style={{ borderColor: `${role.tint}40`, background: `${role.tint}1f`, color: role.tint }}
                                >
                                    <Icon className="h-4 w-4" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-semibold text-white">{role.label}</h3>
                                    <p className="text-xs text-slate-400">{role.description}</p>
                                </div>
                                <Badge className="border border-white/10 bg-white/[0.06] font-mono text-xs text-slate-200">
                                    {currentValue}
                                </Badge>
                            </div>

                            <div className="space-y-3">
                                <Input
                                    list={`gemini-models-${role.key}`}
                                    value={currentValue}
                                    onChange={event => setDraft(previous => ({ ...previous, [role.key]: event.target.value.trim() }))}
                                    placeholder="gemini-2.5-flash-lite"
                                    className="border-white/12 bg-white/[0.055] font-mono text-slate-100 placeholder:text-slate-500"
                                />
                                <datalist id={`gemini-models-${role.key}`}>
                                    {GEMINI_MODELS.map(model => <option key={model} value={model} />)}
                                </datalist>
                                <ChoiceButtons
                                    value={currentValue}
                                    options={GEMINI_MODELS}
                                    onChange={model => setDraft(previous => ({ ...previous, [role.key]: model }))}
                                />
                            </div>
                        </div>
                    );
                })}

                <div className="rounded-2xl border border-[#8dbbff]/20 bg-[#071625]/70 p-5 backdrop-blur-md">
                    <div className="mb-3">
                        <h3 className="font-semibold text-white">Raisonnement Gemini</h3>
                        <p className="mt-1 text-xs text-slate-400">Niveau global appliqué aux modèles Gemini. Les niveaux disponibles dépendent du modèle choisi.</p>
                    </div>
                    <ChoiceButtons
                        value={draft.gemini_thinking_level}
                        options={GEMINI_THINKING_LEVELS}
                        onChange={level => setDraft(previous => ({ ...previous, gemini_thinking_level: level }))}
                    />
                </div>

                <div className="rounded-2xl border border-sky-400/20 bg-[#071625]/70 p-5 backdrop-blur-md">
                    <div className="mb-4 flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-400/30 bg-sky-400/10">
                            <Zap className="h-4 w-4 text-sky-300" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="font-semibold text-white">OCR OpenAI Desktop</h3>
                            <p className="text-xs text-slate-400">Modèle full-page utilisé avec la connexion ChatGPT.</p>
                        </div>
                        <Badge className="max-w-[240px] truncate border border-white/10 bg-white/[0.06] font-mono text-xs text-slate-200">
                            {draft.model_chatgpt_ocr}
                        </Badge>
                    </div>

                    <div className="space-y-3">
                        <Input
                            list="openai-ocr-models"
                            value={draft.model_chatgpt_ocr}
                            onChange={event => setDraft(previous => ({ ...previous, model_chatgpt_ocr: event.target.value.trim() }))}
                            placeholder="gpt-5.6-luna"
                            className="border-white/12 bg-white/[0.055] font-mono text-slate-100 placeholder:text-slate-500"
                        />
                        <datalist id="openai-ocr-models">
                            {OPENAI_OCR_MODELS.map(model => <option key={model} value={model} />)}
                        </datalist>
                        <ChoiceButtons
                            value={draft.model_chatgpt_ocr}
                            options={OPENAI_OCR_MODELS}
                            onChange={model => setDraft(previous => ({ ...previous, model_chatgpt_ocr: model }))}
                            accent="sky"
                        />
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3.5">
                            <p className="text-sm font-medium text-slate-100">Raisonnement OpenAI</p>
                            <p className="mb-3 mt-0.5 text-xs text-slate-400">Effort global. Les niveaux disponibles dépendent du modèle choisi.</p>
                            <ChoiceButtons
                                value={draft.chatgpt_reasoning_effort}
                                options={OPENAI_REASONING_EFFORTS}
                                onChange={effort => setDraft(previous => ({ ...previous, chatgpt_reasoning_effort: effort }))}
                                accent="sky"
                            />
                        </div>
                        <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.04] p-3.5">
                            <div>
                                <p className="text-sm font-medium text-slate-100">Fast mode global</p>
                                <p className="mt-0.5 text-xs text-slate-400">Envoie les requêtes OpenAI sur le tier prioritaire.</p>
                            </div>
                            <Switch
                                checked={draft.chatgpt_fast_mode}
                                onCheckedChange={checked => setDraft(previous => ({ ...previous, chatgpt_fast_mode: checked }))}
                                aria-label="Activer le Fast mode OpenAI global"
                            />
                        </div>
                    </div>
                </div>
            </div>

            <ModelBenchmarkRegistry />

            {hasChanges && (
                <div className="flex items-center gap-3 rounded-xl border border-[#8dbbff]/30 bg-[#3d86ff]/10 p-4 text-sm text-[#bcd6ff]">
                    <div className="h-2 w-2 animate-pulse rounded-full bg-[#3d86ff]" />
                    Modifications non sauvegardées — appliquées à tous les utilisateurs après sauvegarde.
                </div>
            )}

            {/* Embeddings section */}
            <div className="border-t border-white/8 pt-6">
                <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#3d86ff]/25 bg-[#3d86ff]/12">
                            <Sparkles className="h-4 w-4 text-[#8dbbff]" />
                        </div>
                        <div>
                            <h2 className="font-semibold text-white">État des Embeddings</h2>
                            <p className="text-xs text-slate-400">Complétion sémantique des pages.</p>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            onClick={handleTriggerVoyageBackfill}
                            disabled={triggeringVoyageBackfill || loadingStats}
                            variant="outline"
                            className="border-white/12 bg-white/[0.055] text-slate-200 hover:bg-white/12 hover:text-white"
                        >
                            {triggeringVoyageBackfill ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                            Générer Voyage
                        </Button>
                        <Button
                            onClick={handleTriggerGeminiBackfill}
                            disabled={triggeringGeminiBackfill || loadingStats}
                            className="bg-[#3d86ff] hover:bg-[#2f73dc]"
                        >
                            {triggeringGeminiBackfill ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                            Générer Gemini
                        </Button>
                    </div>
                </div>

                {loadingStats ? (
                    <div className="flex justify-center py-10">
                        <Loader2 className="h-6 w-6 animate-spin text-[#8dbbff]" />
                    </div>
                ) : !embeddingStats || embeddingStats.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-white/12 py-10 text-center text-sm text-slate-400">
                        Aucune donnée d&apos;embedding trouvée.
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* Legend */}
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xs">
                            <LegendItem color="bg-blue-500" label="Voyage" value={embeddingStats.filter(s => s.has_description && s.has_voyage && !s.has_gemini).length} />
                            <LegendItem color="bg-yellow-400" label="Gemini" value={embeddingStats.filter(s => s.has_description && !s.has_voyage && s.has_gemini).length} />
                            <LegendItem color="bg-emerald-500" label="Les Deux" value={embeddingStats.filter(s => s.has_description && s.has_voyage && s.has_gemini).length} />
                            <LegendItem color="bg-red-400" label="Aucun" value={embeddingStats.filter(s => s.has_description && !s.has_voyage && !s.has_gemini).length} />
                            <LegendItem color="bg-slate-600" label="Sans desc." value={embeddingStats.filter(s => !s.has_description).length} />
                            <span className="ml-auto font-medium text-slate-400">Total : {embeddingStats.length} pages</span>
                        </div>

                        {isBackfilling && (
                            <div className="rounded-2xl border border-[#8dbbff]/30 bg-[#071625]/80 p-5">
                                <div className="mb-4 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#3d86ff]/18">
                                            <Loader2 className="h-4 w-4 animate-spin text-[#8dbbff]" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-white">Backfill Client en cours…</p>
                                            <p className="text-xs text-slate-400">Votre clé API Gemini personnelle</p>
                                        </div>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => { shouldStopRef.current = true; }}
                                        className="border-rose-400/40 text-rose-300 hover:bg-rose-500/14"
                                    >
                                        <Square className="mr-1 h-3.5 w-3.5" /> Arrêter
                                    </Button>
                                </div>
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs font-medium">
                                        <span className="text-slate-300">Progression</span>
                                        <span className="text-[#8dbbff]">{Math.round((backfillProgress.current / backfillProgress.total) * 100)}% · {backfillProgress.current}/{backfillProgress.total}</span>
                                    </div>
                                    <Progress value={(backfillProgress.current / backfillProgress.total) * 100} className="h-2" />
                                </div>
                                <div className="mt-3 h-28 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-[#020713] p-3 font-mono text-[10px] text-emerald-400">
                                    {backfillProgress.log.map((line, i) => (
                                        <div key={i} className={line.includes('Erreur') ? 'text-red-400' : ''}>
                                            <span className="mr-2 text-slate-600">[{new Date().toLocaleTimeString()}]</span>
                                            {line}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {!isBackfilling && (
                            <div className="flex items-center justify-between gap-4 rounded-xl border border-[#8dbbff]/25 bg-[#3d86ff]/10 p-4">
                                <div>
                                    <p className="text-sm font-semibold text-white">Backfill manuel via client</p>
                                    <p className="text-xs text-[#bcd6ff]">
                                        {embeddingStats.filter(s => !s.has_description || !s.has_voyage || !s.has_gemini).length} pages manquantes, via votre navigateur.
                                    </p>
                                </div>
                                <Button onClick={handleClientBackfill} className="bg-[#3d86ff] hover:bg-[#2f73dc]">
                                    <Play className="mr-2 h-4 w-4" /> Lancer
                                </Button>
                            </div>
                        )}

                        {/* Heatmap */}
                        <div className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                            {embeddingStats.map(page => {
                                let colorClass = "bg-red-400";
                                if (!page.has_description) colorClass = "bg-slate-600";
                                else if (page.has_voyage && page.has_gemini) colorClass = "bg-emerald-500";
                                else if (page.has_voyage) colorClass = "bg-blue-500";
                                else if (page.has_gemini) colorClass = "bg-yellow-400";

                                return (
                                    <div
                                        key={page.id}
                                        title={`Tome ${page.tome_numero} · Chap ${page.chapitre_numero} · Page ${page.numero}`}
                                        className={cn("h-3 w-3 cursor-help rounded-sm opacity-80 transition-opacity hover:opacity-100", colorClass)}
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

function LegendItem({ color, label, value }) {
    return (
        <div className="flex items-center gap-1.5">
            <div className={cn("h-3 w-3 rounded", color)} />
            <span className="text-slate-300">{label}:</span>
            <span className="font-semibold text-white">{value}</span>
        </div>
    );
}
