"use client";
import React, { useState } from 'react';


import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";


import { KeyRound, ExternalLink, ShieldCheck, CheckCircle2, Trash2, ArrowRight } from "lucide-react";

const STORAGE_KEYS = {
    google: 'google_api_key',
    mimo: 'mimo_api_key',
};

function SingleKeySection({ label, storageKey, linkHref, linkLabel, placeholder, onSave, existingKey, setExistingKey, isEditing, setIsEditing }) {
    const [key, setKey] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (key.trim().length > 0) {
            localStorage.setItem(storageKey, key.trim());
            setExistingKey(key.trim());
            setKey('');
            setIsEditing(false);
            window.dispatchEvent(new Event('storage'));
            onSave(key.trim());
            toast.success(`${label} enregistrée avec succès !`);
        }
    };

    const handleRemoveKey = () => {
        localStorage.removeItem(storageKey);
        setExistingKey(null);
        setKey('');
        setIsEditing(true);
        window.dispatchEvent(new Event('storage'));
        toast.info(`${label} supprimée.`);
    };

    const maskKey = (k) => {
        if (!k || k.length < 10) return "••••••••••••••••";
        return k.substring(0, 6) + "••••••••••••••••" + k.substring(k.length - 4);
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <Label className="text-slate-800 font-bold text-sm">{label}</Label>
                {linkHref && (
                    <a
                        href={linkHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-full flex items-center gap-1.5 transition-colors"
                    >
                        {linkLabel} <ExternalLink className="h-3 w-3" />
                    </a>
                )}
            </div>

            {existingKey && !isEditing ? (
                <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg p-3 shadow-sm">
                    <div className="flex items-center gap-3">
                        <div className="bg-emerald-100 p-2 rounded-full">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        </div>
                        <code className="text-sm font-mono text-slate-700 font-semibold tracking-wider">
                            {maskKey(existingKey)}
                        </code>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-slate-400 hover:text-slate-600 text-[10px] h-7 px-2"
                            onClick={() => setIsEditing(true)}
                        >
                            Changer
                        </Button>
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
            ) : (
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="relative group">
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors">
                            <KeyRound className="h-4 w-4" />
                        </div>
                        <Input
                            type="password"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            placeholder={placeholder}
                            className="pl-10 h-10 focus-visible:ring-indigo-500 font-mono text-sm border-slate-200 shadow-sm"
                            autoFocus
                            autoComplete="off"
                        />
                    </div>
                    <div className="flex items-center justify-end gap-2">
                        {existingKey && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setIsEditing(false)}
                                className="text-slate-500 h-8"
                            >
                                Annuler
                            </Button>
                        )}
                        <Button
                            type="submit"
                            disabled={!key.trim()}
                            className="bg-slate-900 hover:bg-slate-800 text-white min-w-[120px] gap-2 shadow-md h-8 text-xs"
                        >
                            Enregistrer <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}

const ApiKeyForm = ({ onSave }) => {
    const [googleKey, setGoogleKey] = useState(() => {
        if (typeof window === 'undefined') return null;
        return localStorage.getItem(STORAGE_KEYS.google) || null;
    });
    const [mimoKey, setMimoKey] = useState(() => {
        if (typeof window === 'undefined') return null;
        return localStorage.getItem(STORAGE_KEYS.mimo) || null;
    });
    const [isEditingGoogle, setIsEditingGoogle] = useState(() => {
        if (typeof window === 'undefined') return true;
        return !localStorage.getItem(STORAGE_KEYS.google);
    });
    const [isEditingMimo, setIsEditingMimo] = useState(() => {
        if (typeof window === 'undefined') return true;
        return !localStorage.getItem(STORAGE_KEYS.mimo);
    });

    const handleGoogleSave = (key) => {
        onSave(key);
    };

    const handleMimoSave = () => {};

    return (
        <div className="space-y-6 pt-2">
            <div className="bg-amber-50 border border-amber-100/60 rounded-xl p-4 flex gap-3.5 items-start shadow-sm">
                <div className="bg-amber-100 p-1.5 rounded-full shrink-0">
                    <ShieldCheck className="h-5 w-5 text-amber-600" />
                </div>
                <div className="text-sm text-amber-900/90 pt-0.5">
                    <p className="font-bold text-amber-900 mb-1">Confidentialité Maximale</p>
                    <p className="text-amber-800/80 leading-relaxed text-xs">
                        Ces clés permettent d&apos;utiliser l&apos;IA sur le projet. Elles sont stockées <strong>localement dans votre navigateur</strong> et ne sont jamais transmises ou conservées sur nos serveurs.
                    </p>
                </div>
            </div>

            <SingleKeySection
                label="Clé API Google Gemini"
                storageKey={STORAGE_KEYS.google}
                linkHref="https://aistudio.google.com/app/apikey"
                linkLabel="Obtenir une clé"
                placeholder="Collez votre clé ici (ex: AIzaSy...)"
                onSave={handleGoogleSave}
                existingKey={googleKey}
                setExistingKey={setGoogleKey}
                isEditing={isEditingGoogle}
                setIsEditing={setIsEditingGoogle}
            />

            <div className="border-t border-slate-100" />

            <SingleKeySection
                label="Clé API MiMo (Xiaomi)"
                storageKey={STORAGE_KEYS.mimo}
                linkHref="https://platform.xiaomimimo.com/#/console/api-keys"
                linkLabel="Obtenir une clé"
                placeholder="Collez votre clé ici (ex: sk-...)"
                onSave={handleMimoSave}
                existingKey={mimoKey}
                setExistingKey={setMimoKey}
                isEditing={isEditingMimo}
                setIsEditing={setIsEditingMimo}
            />
        </div>
    );
};

export default ApiKeyForm;
