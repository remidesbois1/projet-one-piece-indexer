"use client";
import React, { useState } from 'react';

// UI Components
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Icons
import { KeyRound, ExternalLink, ShieldCheck } from "lucide-react";

const ApiKeyForm = ({ onSave }) => {
    const [key, setKey] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (key.trim().length > 0) {
            onSave(key.trim());
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6 pt-2">

            {/* Note de confidentialité / Info */}
            <div className="bg-blue-50 border border-blue-100 rounded-md p-3 flex gap-3 items-start">
                <ShieldCheck className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
                <div className="text-sm text-blue-900">
                    <p className="font-medium">Confidentialité</p>
                    <p className="text-blue-700/80 mt-1 leading-relaxed">
                        Cette clé est requise pour l'analyse automatique par l'IA.
                        Elle est stockée <strong>uniquement dans votre navigateur</strong> (LocalStorage)
                        et n'est jamais sauvegardée sur nos serveurs.
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                <div className="flex justify-between items-center">
                    <Label htmlFor="api-key" className="text-slate-700 font-semibold">
                        Clé API Google (AI Studio)
                    </Label>
                    <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1 font-medium transition-colors"
                    >
                        Obtenir une clé gratuite <ExternalLink className="h-3 w-3" />
                    </a>
                </div>

                <div className="relative">
                    <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <Input
                        id="api-key"
                        type="password"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder="Collez votre clé ici (ex: AIzaSy...)"
                        className="pl-9 font-mono text-sm"
                        autoFocus
                        autoComplete="off"
                    />
                </div>
                <p className="text-[11px] text-slate-500">
                    Nécessite une clé valide pour le modèle Gemini Flash.
                </p>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
                <Button
                    type="submit"
                    disabled={!key.trim()}
                    className="bg-slate-900 hover:bg-slate-800 text-white"
                >
                    Enregistrer et Continuer
                </Button>
            </div>
        </form>
    );
};

export default ApiKeyForm;
