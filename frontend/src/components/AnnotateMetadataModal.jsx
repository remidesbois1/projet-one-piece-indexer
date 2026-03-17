import React from 'react';
import { 
    Dialog, 
    DialogContent, 
    DialogHeader, 
    DialogTitle, 
    DialogDescription, 
    DialogFooter 
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FileText, Code, Sparkles, Loader2, Plus, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AnnotateMetadataModal({
    isOpen,
    onOpenChange,
    tabMode,
    setTabMode,
    formData,
    setFormData,
    charInput,
    setCharInput,
    suggestions,
    isGeneratingAI,
    handleGenerateAI,
    handleSaveDescription,
    isSavingDesc,
    jsonInput,
    handleJsonChange,
    jsonError
}) {
    const addCharacter = (char) => {
        const cleanChar = char.trim();
        if (cleanChar && !formData.characters.includes(cleanChar)) {
            setFormData(prev => ({
                ...prev,
                characters: [...prev.characters, cleanChar]
            }));
        }
        setCharInput("");
    };

    const removeCharacter = (char) => {
        setFormData(prev => ({
            ...prev,
            characters: prev.characters.filter(c => c !== char)
        }));
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <div className="flex items-center justify-between pr-4">
                        <div>
                            <DialogTitle className="flex items-center gap-2">
                                <FileText className="h-5 w-5 text-indigo-600" />
                                Description Sémantique
                            </DialogTitle>
                            <DialogDescription>
                                Définition des métadonnées pour le moteur de recherche.
                            </DialogDescription>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleGenerateAI}
                            disabled={isGeneratingAI}
                            className="gap-2 border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
                        >
                            {isGeneratingAI ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                            Générer avec IA
                        </Button>
                    </div>
                </DialogHeader>

                <Tabs value={tabMode} onValueChange={setTabMode} className="w-full">
                    <TabsList className="grid w-full grid-cols-2 mb-4">
                        <TabsTrigger value="form">
                            <FileText className="h-4 w-4 mr-2" />
                            Formulaire
                        </TabsTrigger>
                        <TabsTrigger value="json">
                            <Code className="h-4 w-4 mr-2" />
                            JSON Raw
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="form" className="space-y-4 outline-none">
                        <div className="flex flex-col gap-3">
                            <Label htmlFor="scene-content" className="text-sm font-semibold text-slate-700">
                                Contenu Sémantique
                            </Label>
                            <Textarea
                                id="scene-content"
                                value={formData.content}
                                onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                                className="min-h-[120px] resize-none border-slate-200 focus:ring-indigo-500"
                                placeholder="Description de l'action, des lieux..."
                            />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="flex flex-col gap-3">
                                <Label className="text-sm font-semibold text-slate-700">Arc Narratif</Label>
                                <div className="relative">
                                    <input
                                        list="arc-suggestions"
                                        value={formData.arc}
                                        onChange={(e) => {
                                            setFormData(prev => ({ ...prev, arc: e.target.value }));
                                        }}
                                        className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:ring-indigo-500 focus:outline-none focus:ring-2"
                                        placeholder="Ex: Water 7"
                                    />
                                    <datalist id="arc-suggestions">
                                        {suggestions.arcs.map(arc => <option key={arc} value={arc} />)}
                                    </datalist>
                                </div>
                            </div>

                            <div className="flex flex-col gap-3">
                                <Label className="text-sm font-semibold text-slate-700">Personnages</Label>
                                <div className="flex flex-col gap-2">
                                    <div className="flex gap-2">
                                        <input
                                            list="char-suggestions"
                                            value={charInput}
                                            onChange={(e) => setCharInput(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && addCharacter(charInput)}
                                            className="flex h-10 flex-1 rounded-md border border-slate-200 px-3 text-sm focus:ring-indigo-500 focus:outline-none focus:ring-2"
                                            placeholder="Ajouter..."
                                        />
                                        <datalist id="char-suggestions">
                                            {suggestions.characters.map(c => <option key={c} value={c} />)}
                                        </datalist>
                                        <Button size="icon" variant="secondary" onClick={() => addCharacter(charInput)}>
                                            <Plus className="h-4 w-4" />
                                        </Button>
                                    </div>
                                    <div className="flex flex-wrap gap-2 min-h-[40px] p-2 bg-slate-50 rounded border border-dashed border-slate-200">
                                        {formData.characters.map(char => (
                                            <Badge key={char} variant="secondary" className="gap-1 bg-white hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer" onClick={() => removeCharacter(char)}>
                                                {char} <X className="h-3 w-3" />
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="json" className="outline-none">
                        <div className="relative">
                            <Textarea
                                value={jsonInput}
                                onChange={handleJsonChange}
                                className={cn(
                                    "font-mono text-xs min-h-[350px] bg-slate-900 text-slate-50 resize-none",
                                    jsonError ? "border-red-500 focus:ring-red-500" : "border-slate-800 focus:ring-slate-700"
                                )}
                                spellCheck={false}
                            />
                            {jsonError && (
                                <div className="absolute bottom-4 left-4 right-4 bg-red-500/90 text-white text-xs p-2 rounded shadow-lg backdrop-blur-sm">
                                    Erreur JSON: {jsonError}
                                </div>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Fermer</Button>
                    <Button onClick={handleSaveDescription} disabled={isSavingDesc || !!jsonError} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                        {isSavingDesc ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        Enregistrer
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
