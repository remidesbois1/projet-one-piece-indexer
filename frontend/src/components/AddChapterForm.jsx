import React, { useState, useEffect } from 'react';
import { useManga } from '@/context/MangaContext';
import { getTomes, uploadChapter } from '@/lib/api';

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, UploadCloud, FileArchive, CheckCircle2, AlertCircle } from "lucide-react";

const AddChapterForm = () => {
    const { mangaSlug } = useManga();
    const [tomes, setTomes] = useState([]);
    const [selectedTome, setSelectedTome] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [feedback, setFeedback] = useState({ type: null, message: '' });

    useEffect(() => {
        const fetchTomes = async () => {
            if (mangaSlug) {
                try {
                    const response = await getTomes(mangaSlug);
                    setTomes(response.data.sort((a, b) => b.numero - a.numero));
                } catch (error) {
                    console.error("Impossible de charger les tomes", error);
                }
            }
        };
        fetchTomes();
    }, [mangaSlug]);

    const handleSubmit = async (event) => {
        event.preventDefault();
        setIsSubmitting(true);
        setFeedback({ type: null, message: '' });

        const formData = new FormData(event.target);

        if (!formData.get('tome_id')) {
            setFeedback({ type: 'error', message: "Veuillez sélectionner un tome." });
            setIsSubmitting(false);
            return;
        }

        try {
            const response = await uploadChapter(formData);
            setFeedback({ type: 'success', message: response.data.message || "Chapitre uploadé avec succès !" });
            event.target.reset();
            setSelectedTome('');
        } catch (error) {
            const errorMessage = error.response?.data?.error || "Une erreur est survenue lors de l'upload.";
            setFeedback({ type: 'error', message: errorMessage });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form
            onSubmit={handleSubmit}
            className="flex flex-col rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md"
        >
            <div className="mb-4 flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-500/12">
                    <FileArchive className="h-4 w-4 text-amber-300" />
                </div>
                <div>
                    <h3 className="font-semibold leading-tight text-white">Nouveau Chapitre</h3>
                    <p className="text-xs text-slate-400">Importez un .cbz ou .zip.</p>
                </div>
            </div>

            <div className="flex-1 space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label className="text-xs text-slate-400">Tome</Label>
                        <Select value={selectedTome} onValueChange={setSelectedTome}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="-- Sélectionner --" />
                            </SelectTrigger>
                            <SelectContent>
                                {tomes.map(tome => (
                                    <SelectItem key={tome.id} value={String(tome.id)}>
                                        Tome {tome.numero} — {tome.titre}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <input type="hidden" name="tome_id" value={selectedTome} />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="chap-numero" className="text-xs text-slate-400">Numéro</Label>
                        <Input id="chap-numero" type="number" name="numero" placeholder="Ex: 1054" required />
                    </div>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="chap-titre" className="text-xs text-slate-400">Titre</Label>
                    <Input id="chap-titre" type="text" name="titre" placeholder="Ex: L'empereur des flammes" required />
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="chap-file" className="text-xs text-slate-400">Fichier source (.cbz / .zip)</Label>
                    <Input
                        id="chap-file"
                        type="file"
                        name="cbzFile"
                        accept=".cbz,.zip"
                        required
                        className="cursor-pointer file:mr-4 file:rounded-full file:border-0 file:bg-[#3d86ff]/18 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-[#bdd6ff] hover:file:bg-[#3d86ff]/28"
                    />
                </div>

                {feedback.message && (
                    <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${feedback.type === 'error'
                        ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
                        : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                        }`}>
                        {feedback.type === 'error'
                            ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                        }
                        <span>{feedback.message}</span>
                    </div>
                )}
            </div>

            <div className="mt-5 flex justify-end">
                <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="min-w-[160px] bg-[#3d86ff] hover:bg-[#2f73dc]"
                >
                    {isSubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Upload...</>
                    ) : (
                        <><UploadCloud className="mr-2 h-4 w-4" /> Ajouter le Chapitre</>
                    )}
                </Button>
            </div>
        </form>
    );
};

export default AddChapterForm;
