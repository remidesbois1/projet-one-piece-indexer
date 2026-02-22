"use client";
import React, { useState, useEffect } from 'react';


import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";


import { KeyRound, ExternalLink, ShieldCheck, CheckCircle2, Trash2, ArrowRight } from "lucide-react";

const ApiKeyForm = ({ onSave }) => {
    const [key, setKey] = useState('');
    const [existingKey, setExistingKey] = useState(null);
    const [isEditing, setIsEditing] = useState(false);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const savedKey = localStorage.getItem('google_api_key');
            if (savedKey) {
                setExistingKey(savedKey);
            } else {
                setIsEditing(true); 
            }
        }
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (key.trim().length > 0) {
            onSave(key.trim());
            toast.success("Clé API enregistrée avec succès !");
        }
    };

    const handleRemoveKey = () => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('google_api_key');
            setExistingKey(null);
            setKey('');
            setIsEditing(true);
            window.dispatchEvent(new Event('storage'));
            toast.info("Clé API supprimée.");
        }
    };

    const maskKey = (k) => {
        if (!k || k.length < 10) return "••••••••••••••••";
        return k.substring(0, 6) + "••••••••••••••••" + k.substring(k.length - 4);
    };

    return (
        <div className="space-y-6 pt-2">

            
            <div className="bg-amber-50 border border-amber-100/60 rounded-xl p-4 flex gap-3.5 items-start shadow-sm">
                <div className="bg-amber-100 p-1.5 rounded-full shrink-0">
                    <ShieldCheck className="h-5 w-5 text-amber-600" />
                </div>
                <div className="text-sm text-amber-900/90 pt-0.5">
                    <p className="font-bold text-amber-900 mb-1">Confidentialité Maximale</p>
                    <p className="text-amber-800/80 leading-relaxed text-xs">
                        Cette clé permet d'utiliser l'IA de Google sur le projet (Recherche sémantique très performante, OCR et génération de description si vous êtes Modérateur). Elle est stockée <strong>localement dans votre navigateur</strong> et n'est jamais transmise ou conservée sur nos serveurs.
                    </p>
                </div>
            </div>

            {existingKey && !isEditing ? (
                <div className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <Label className="text-slate-700 font-bold text-sm">Clé Actuelle</Label>
                        <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg p-3 shadow-sm">
                            <div className="flex items-center gap-3">
                                <div className="bg-emerald-100 p-2 rounded-full">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                </div>
                                <code className="text-sm font-mono text-slate-700 font-semibold tracking-wider">
                                    {maskKey(existingKey)}
                                </code>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="text-red-500 hover:text-red-600 hover:bg-red-50 h-8 w-8"
                                onClick={handleRemoveKey}
                                title="Supprimer la clé"
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    <div className="pt-2">
                        <Button
                            variant="outline"
                            className="w-full text-slate-600 border-slate-200 hover:bg-slate-50"
                            onClick={() => setIsEditing(true)}
                        >
                            Changer de clé API
                        </Button>
                    </div>
                </div>
            ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                    <div className="space-y-3">
                        <div className="flex justify-between items-center">
                            <Label htmlFor="api-key" className="text-slate-800 font-bold text-sm">
                                {existingKey ? "Nouvelle Clé API" : "Clé API Google Gemini"}
                            </Label>
                            <a
                                href="https://aistudio.google.com/app/apikey"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-full flex items-center gap-1.5 transition-colors"
                            >
                                Obtenir une clé <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>

                        <div className="relative group">
                            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors">
                                <KeyRound className="h-4 w-4" />
                            </div>
                            <Input
                                id="api-key"
                                type="password"
                                value={key}
                                onChange={(e) => setKey(e.target.value)}
                                placeholder="Collez votre clé ici (ex: AIzaSy...)"
                                className="pl-10 h-11 focus-visible:ring-indigo-500 font-mono text-sm border-slate-200 shadow-sm"
                                autoFocus
                                autoComplete="off"
                            />
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                        {existingKey && (
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setIsEditing(false)}
                                className="text-slate-500"
                            >
                                Annuler
                            </Button>
                        )}
                        <Button
                            type="submit"
                            disabled={!key.trim()}
                            className="bg-slate-900 hover:bg-slate-800 text-white min-w-[140px] gap-2 shadow-md"
                        >
                            Enregistrer <ArrowRight className="h-4 w-4" />
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
};

export default ApiKeyForm;
