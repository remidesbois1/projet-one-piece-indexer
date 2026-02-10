import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
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
  const { mangaSlug } = useManga();
  const [tomes, setTomes] = useState([]);

  // States UI
  const [selectedTome, setSelectedTome] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState({ type: null, message: '' });

  useEffect(() => {
    const fetchTomes = async () => {
      if (session && mangaSlug) {
        try {
          const response = await getTomes(mangaSlug);
          setTomes(response.data.sort((a, b) => b.numero - a.numero));
        } catch (error) {
          console.error("Impossible de charger les tomes", error);
        }
      }
    };
    fetchTomes();
  }, [session, mangaSlug]);

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
    } catch (error) {
      const errorMessage = error.response?.data?.error || "Une erreur est survenue lors de l'upload.";
      setFeedback({ type: 'error', message: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="border-slate-200 shadow-sm border-none shadow-none bg-slate-50/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-2xl font-bold">
          <FileArchive className="h-6 w-6 text-orange-600" />
          Nouveau Chapitre
        </CardTitle>
        <CardDescription className="text-base">
          Importez un chapitre via un fichier compressé (.cbz ou .zip).
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} id="add-chapter-form" className="space-y-6">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>Appartient au Tome</Label>

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