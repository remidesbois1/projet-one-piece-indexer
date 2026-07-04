import React, { useState } from 'react';
import { useManga } from '@/context/MangaContext';
import { createTome } from '@/lib/api';

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, PlusCircle, Book } from "lucide-react";

const AddTomeForm = ({ onTomeAdded }) => {
    const { mangaSlug } = useManga();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (event) => {
        event.preventDefault();
        setIsSubmitting(true);

        const formData = new FormData(event.target);
        const numero = formData.get('numero');
        const titre = formData.get('titre');

        try {
            await createTome({ numero, titre }, mangaSlug);
            event.target.reset();
            if (onTomeAdded) onTomeAdded();
        } catch (error) {
            const errorMessage = error.response?.data?.error || "Une erreur est survenue.";
            alert(errorMessage);
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
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#3d86ff]/25 bg-[#3d86ff]/12">
                    <Book className="h-4 w-4 text-[#8dbbff]" />
                </div>
                <div>
                    <h3 className="font-semibold leading-tight text-white">Nouveau Tome</h3>
                    <p className="text-xs text-slate-400">Créez un volume pour vos chapitres.</p>
                </div>
            </div>

            <div className="grid flex-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <Label htmlFor="tome-numero" className="text-xs text-slate-400">Numéro</Label>
                    <Input id="tome-numero" type="number" name="numero" placeholder="Ex: 104" required min="1" />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="tome-titre" className="text-xs text-slate-400">Titre</Label>
                    <Input id="tome-titre" type="text" name="titre" placeholder="Ex: Shogun de Wano" required />
                </div>
            </div>

            <div className="mt-5 flex justify-end">
                <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-[#3d86ff] hover:bg-[#2f73dc]"
                >
                    {isSubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
                    ) : (
                        <><PlusCircle className="mr-2 h-4 w-4" /> Créer le Tome</>
                    )}
                </Button>
            </div>
        </form>
    );
};

export default AddTomeForm;
