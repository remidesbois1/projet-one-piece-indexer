import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getTomes, uploadChapter } from '@/lib/api';

// UI Components
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, UploadCloud, FileArchive, AlertCircle, CheckCircle2 } from "lucide-react";

const AddChapterForm = () => {
  const { session } = useAuth();
  const [tomes, setTomes] = useState([]);

  // States UI
  const [selectedTome, setSelectedTome] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState({ type: null, message: '' }); // type: 'success' | 'error'

  useEffect(() => {
    const fetchTomes = async () => {
      if (session) {
        try {
          const response = await getTomes();
          // On trie les tomes par numéro décroissant pour faciliter l'ajout récent
          setTomes(response.data.sort((a, b) => b.numero - a.numero));
        } catch (error) {
          console.error("Impossible de charger les tomes", error);
        }
      }
    };
    fetchTomes();
  }, [session]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback({ type: null, message: '' });

    const formData = new FormData(event.target);

    // Vérification manuelle car le Select shadcn est parfois capricieux avec FormData si mal lié
    if (!formData.get('tome_id')) {
      setFeedback({ type: 'error', message: "Veuillez sélectionner un tome." });
      setIsSubmitting(false);
      return;
    }

    try {
      const response = await uploadChapter(formData);

      setFeedback({ type: 'success', message: response.data.message || "Chapitre uploadé avec succès !" });

      // Reset partiel du form
      event.target.reset();
      // On garde le tome sélectionné pour enchainer les uploads si besoin, sinon : setSelectedTome('');
    } catch (error) {
      const errorMessage = error.response?.data?.error || "Une erreur est survenue lors de l'upload.";
      setFeedback({ type: 'error', message: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <FileArchive className="h-5 w-5 text-orange-600" />
          2. Ajouter un Chapitre (via .cbz)
        </CardTitle>
        <CardDescription>
          Importez un fichier compressé (.cbz ou .zip) contenant les pages du chapitre.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} id="add-chapter-form" className="space-y-6">

          {/* --- LIGNE 1 : Tome & Numéro --- */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>Appartient au Tome</Label>

              {/* Select Shadcn */}
              <Select value={selectedTome} onValueChange={setSelectedTome}>
                <SelectTrigger>
                  <SelectValue placeholder="-- Sélectionner un tome --" />
                </SelectTrigger>
                <SelectContent>
                  {tomes.map(tome => (
                    <SelectItem key={tome.id} value={String(tome.id)}>
                      Tome {tome.numero} - {tome.titre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Input caché indispensable pour que FormData récupère la valeur */}
              <input type="hidden" name="tome_id" value={selectedTome} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="chap-numero">Numéro du chapitre</Label>
              <Input
                id="chap-numero"
                type="number"
                name="numero"
                placeholder="Ex: 1054"
                required
              />
            </div>
          </div>

          {/* --- LIGNE 2 : Titre --- */}
          <div className="space-y-2">
            <Label htmlFor="chap-titre">Titre du chapitre</Label>
            <Input
              id="chap-titre"
              type="text"
              name="titre"
              placeholder="Ex: L'empereur des flammes"
              required
            />
          </div>

          {/* --- LIGNE 3 : Fichier --- */}
          <div className="space-y-2">
            <Label htmlFor="chap-file">Fichier source (.cbz)</Label>
            <Input
              id="chap-file"
              type="file"
              name="cbzFile"
              accept=".cbz,.zip"
              required
              className="cursor-pointer file:mr-4 file:py-1 file:px-2 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
            />
          </div>

          {/* --- Feedback Message --- */}
          {feedback.message && (
            <Alert variant={feedback.type === 'error' ? "destructive" : "default"} className={feedback.type === 'success' ? "border-green-200 bg-green-50 text-green-800" : ""}>
              {feedback.type === 'error' ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-green-600" />}
              <AlertTitle>{feedback.type === 'error' ? "Erreur" : "Succès"}</AlertTitle>
              <AlertDescription>
                {feedback.message}
              </AlertDescription>
            </Alert>
          )}

        </form>
      </CardContent>

      <CardFooter className="bg-slate-50/50 border-t border-slate-100 flex justify-end py-3">
        <Button
          type="submit"
          form="add-chapter-form"
          disabled={isSubmitting}
          className="bg-slate-900 hover:bg-slate-800 min-w-[150px]"
        >
          {isSubmitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Upload en cours...</>
          ) : (
            <><UploadCloud className="mr-2 h-4 w-4" /> Ajouter le Chapitre</>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
};

export default AddChapterForm;