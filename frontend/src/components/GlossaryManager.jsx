import React, { useState, useEffect } from 'react';
import { getGlossary, addGlossaryWord, deleteGlossaryWord } from '@/lib/api';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Loader2, Plus, X, BookOpen, Trash2 } from "lucide-react";

const GlossaryManager = () => {
    const [words, setWords] = useState([]);
    const [newWord, setNewWord] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const fetchGlossary = async () => {
        setLoading(true);
        try {
            const response = await getGlossary();
            setWords(response.data);
            setError(null);
        } catch (err) {
            setError("Erreur lors du chargement du glossaire.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchGlossary();
    }, []);

    const handleAddWord = async (e) => {
        e.preventDefault();
        const trimmedWord = newWord.trim();
        if (!trimmedWord) return;

        try {
            await addGlossaryWord(trimmedWord);
            setNewWord("");
            fetchGlossary();
        } catch (err) {
            if (err.response?.status === 409) {
                alert("Ce mot existe déjà dans le glossaire.");
            } else {
                alert("Erreur lors de l'ajout.");
            }
        }
    };

    const handleDeleteWord = async (word) => {
        if (!window.confirm(`Supprimer "${word}" du glossaire ?`)) return;
        try {
            await deleteGlossaryWord(word);
            fetchGlossary();
        } catch (err) {
            alert("Erreur lors de la suppression.");
        }
    };

    return (
        <Card className="w-full border-slate-200 shadow-sm overflow-hidden">
            <CardHeader className="bg-slate-50/50 border-b border-slate-100">
                <div className="flex items-center gap-2">
                    <BookOpen className="h-5 w-5 text-indigo-600" />
                    <CardTitle className="text-xl">Glossaire de Protection</CardTitle>
                </div>
                <CardDescription>
                    Les mots listés ici ne seront jamais modifiés par LanguageTool (utile pour les noms propres).
                </CardDescription>
            </CardHeader>

            <CardContent className="p-6">
                <form onSubmit={handleAddWord} className="flex gap-2 mb-6">
                    <Input
                        placeholder="Ajouter un nom propre (ex: Luffy, Zoro...)"
                        value={newWord}
                        onChange={(e) => setNewWord(e.target.value)}
                        className="flex-1"
                    />
                    <Button type="submit" disabled={!newWord.trim() || loading}>
                        <Plus className="h-4 w-4 mr-2" /> Ajouter
                    </Button>
                </form>

                {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

                <div className="relative min-h-[200px] border rounded-lg bg-slate-50/30 p-4">
                    {loading && words.length === 0 ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
                        </div>
                    ) : words.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-[160px] text-slate-400">
                            <BookOpen className="h-10 w-10 mb-2 opacity-20" />
                            <p className="text-sm">Le glossaire est vide.</p>
                        </div>
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {words.map((word) => (
                                <Badge
                                    key={word}
                                    variant="secondary"
                                    className="pl-3 pr-1 py-1 gap-1 text-sm bg-white border-slate-200 hover:border-red-200 hover:bg-red-50 group transition-all"
                                >
                                    {word}
                                    <button
                                        onClick={() => handleDeleteWord(word)}
                                        className="p-0.5 rounded-full hover:bg-red-100 text-slate-400 group-hover:text-red-600 transition-colors"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </Badge>
                            ))}
                        </div>
                    )}
                </div>
            </CardContent>

            <CardFooter className="bg-slate-50/30 border-t border-slate-100 py-3 px-6">
                <p className="text-xs text-slate-500">
                    Ces mots sont automatiquement ignorés lors de la correction grammaticale.
                </p>
            </CardFooter>
        </Card>
    );
};

export default GlossaryManager;
