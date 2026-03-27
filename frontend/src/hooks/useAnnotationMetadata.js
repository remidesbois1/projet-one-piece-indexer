"use client";

import { useState, useEffect, useCallback } from 'react';
import { getMetadataSuggestions, savePageDescription } from '@/lib/api';
import { generatePageDescription, generateGeminiEmbedding } from '@/lib/geminiClient';
import { toast } from 'sonner';

export function useAnnotationMetadata({
    page,
    setPage,
    pageId,
    imageRef,
    showDescModal,
    setShowDescModal,
    setShowApiKeyModal,
    onSaveDescription = null,
    onFetchSuggestions = null
}) {
    const [formData, setFormData] = useState({
        content: "",
        arc: "",
        characters: []
    });
    const [suggestions, setSuggestions] = useState({
        arcs: [],
        characters: []
    });
    const [charInput, setCharInput] = useState("");
    const [isSavingDesc, setIsSavingDesc] = useState(false);
    const [isGeneratingAI, setIsGeneratingAI] = useState(false);
    const [tabMode, setTabMode] = useState("form");
    const [jsonInput, setJsonInput] = useState("");
    const [jsonError, setJsonError] = useState(null);

    useEffect(() => {
        if (tabMode === 'form') {
            const jsonStructure = {
                content: formData.content,
                metadata: {
                    arc: formData.arc,
                    characters: formData.characters
                }
            };
            setJsonInput(JSON.stringify(jsonStructure, null, 4));
            setJsonError(null);
        }
    }, [formData, tabMode]);

    const handleJsonChange = (e) => {
        const val = e.target.value;
        setJsonInput(val);
        try {
            const parsed = JSON.parse(val);
            if (typeof parsed !== 'object' || parsed === null) throw new Error("Le JSON doit être un objet.");
            if (!parsed.metadata || typeof parsed.metadata !== 'object') throw new Error("L'objet doit contenir une clé 'metadata'.");

            setJsonError(null);
            setFormData(prev => ({
                ...prev,
                content: parsed.content || "",
                arc: parsed.metadata.arc || "",
                characters: Array.isArray(parsed.metadata.characters) ? parsed.metadata.characters : []
            }));
        } catch (err) {
            setJsonError(err.message);
        }
    };

    useEffect(() => {
        if (page?.description) {
            let desc = page.description;
            if (typeof desc === 'string') {
                try {
                    desc = JSON.parse(desc);
                } catch (e) {
                    desc = { content: page.description, metadata: { arc: "", characters: [] } };
                }
            }

            const newFormData = {
                content: desc.content || "",
                arc: desc.metadata?.arc || "",
                characters: desc.metadata?.characters || []
            };

            setFormData(newFormData);
            setJsonInput(JSON.stringify({
                content: newFormData.content,
                metadata: { arc: newFormData.arc, characters: newFormData.characters }
            }, null, 4));
            setJsonError(null);
        }
    }, [page]);

    const fetchSuggestions = useCallback(async () => {
        try {
            const res = onFetchSuggestions ? await onFetchSuggestions() : await getMetadataSuggestions();
            setSuggestions(res.data);
        } catch (err) {
            console.error("Erreur suggestions:", err);
        }
    }, [onFetchSuggestions]);

    useEffect(() => {
        if (showDescModal) {
            fetchSuggestions();
        }
    }, [showDescModal, fetchSuggestions]);

    const handleSaveDescription = async () => {
        const payload = {
            content: formData.content,
            metadata: {
                arc: formData.arc,
                characters: formData.characters
            }
        };

        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            setShowApiKeyModal(true);
            return;
        }

        const previousPage = { ...page };
        setPage(prev => ({
            ...prev,
            description: JSON.stringify(payload)
        }));
        setShowDescModal(false);
        setIsSavingDesc(true);

        try {
            let geminiEmb = null;
            if (storedKey && imageRef.current && (formData.content || formData.characters?.length > 0)) {
                try {
                    const textToEmbed = `${formData.content} ${formData.characters?.join(' ')}`.trim();
                    geminiEmb = await generateGeminiEmbedding(textToEmbed, imageRef.current, storedKey);
                } catch (embErr) {
                    console.error("Gemini embedding error:", embErr);
                }
            }

            if (onSaveDescription) {
                await onSaveDescription(payload, geminiEmb);
            } else {
                await savePageDescription(pageId, payload, null, geminiEmb);
            }
            toast.success("Description et vecteurs enregistrés !");
        } catch (error) {
            setPage(previousPage);
            console.error(error);
            toast.error("Erreur lors de la sauvegarde.");
        } finally {
            setIsSavingDesc(false);
        }
    };

    const handleGenerateAI = async () => {
        const storedKey = localStorage.getItem('google_api_key');
        if (!storedKey) {
            setShowApiKeyModal(true);
            return;
        }

        setIsGeneratingAI(true);
        try {
            const res = await generatePageDescription(imageRef.current, storedKey);
            const aiData = res.data;

            setFormData({
                content: aiData.content || "",
                arc: aiData.metadata?.arc || "",
                characters: Array.isArray(aiData.metadata?.characters) ? aiData.metadata.characters : []
            });

            setJsonInput(JSON.stringify(aiData, null, 4));
            setJsonError(null);

        } catch (error) {
            if (error.message === "QUOTA_EXCEEDED") {
                toast.error("Quota API Gemini dépassé !");
            } else {
                console.error("Erreur génération AI:", error);
                toast.error("Erreur lors de la génération par IA.");
            }
        } finally {
            setIsGeneratingAI(false);
        }
    };

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

    return {
        formData,
        setFormData,
        suggestions,
        charInput,
        setCharInput,
        isSavingDesc,
        isGeneratingAI,
        tabMode,
        setTabMode,
        jsonInput,
        jsonError,
        handleJsonChange,
        handleSaveDescription,
        handleGenerateAI,
        addCharacter,
        removeCharacter
    };
}
