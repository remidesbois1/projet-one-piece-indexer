import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createTome } from '../services/api';

// UI Components
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, PlusCircle, Book } from "lucide-react";

const AddTomeForm = ({ onTomeAdded }) => {
  const { session } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSubmitting(true);

    const formData = new FormData(event.target);
    const numero = formData.get('numero');
    const titre = formData.get('titre');

    try {
      await createTome({ numero, titre });
      alert(`Le tome ${numero} a été créé avec succès !`);
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
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Book className="h-5 w-5 text-blue-600" />
          1. Créer un Nouveau Tome
        </CardTitle>
        <CardDescription>
          Ajoutez un volume (Tome) avant de pouvoir y lier des chapitres.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} id="add-tome-form" className="grid gap-6 sm:grid-cols-2">

          <div className="space-y-2">
            <Label htmlFor="tome-numero">Numéro du Tome</Label>
            <Input
              id="tome-numero"
              type="number"
              name="numero"
              placeholder="Ex: 104"
              required
              min="1"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tome-titre">Titre du Tome</Label>
            <Input
              id="tome-titre"
              type="text"
              name="titre"
              placeholder="Ex: Shogun de Wano"
              required
            />
          </div>

        </form>
      </CardContent>

      <CardFooter className="bg-slate-50/50 border-t border-slate-100 flex justify-end py-3">
        <Button
          type="submit"
          form="add-tome-form"
          disabled={isSubmitting}
          className="bg-slate-900 hover:bg-slate-800"
        >
          {isSubmitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
          ) : (
            <><PlusCircle className="mr-2 h-4 w-4" /> Créer le Tome</>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
};

export default AddTomeForm;