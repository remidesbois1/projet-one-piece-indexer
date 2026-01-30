import { GoogleGenerativeAI } from "@google/generative-ai";
import { cropImage } from "./utils";

const ANALYSIS_PROMPT = "Tu es un expert en numérisation de manga. Ta tâche est de transcrire le texte présent dans cette bulle de dialogue.  Règles strictes : 1. Transcris EXACTEMENT le texte visible (OCR). 2. Corrige automatiquement les erreurs mineures d'OCR. 3. Rétablis la casse naturelle. 4. Ne traduis pas. Reste en Français. 5. Renvoie UNIQUEMENT le texte final.";

const DESCRIPTION_PROMPT = "Analyse cette page de One Piece. Ton but est de générer un objet JSON optimisé pour la similarité cosinus. La description doit être dense, directe et centrée sur l'action principale pour maximiser les scores de correspondance. Schéma de sortie attendu : JSON { \"content\": \"Action principale. Détails de l'événement et contexte immédiat. Éléments de lore.\", \"metadata\": { \"arc\": \"Nom de l'arc\", \"characters\": [\"Liste des personnages\"] } } Règles de rédaction pour 'content' (Priorité Recherche) : Accroche Directe : Commence la première phrase par l'action ou l'événement exact (ex: \"Exécution de Gol D. Roger\" ou \"Combat entre Luffy et Kaido\"). C'est ce qui \"ancre\" le vecteur. Sujet-Verbe-Complément : Utilise des phrases simples et factuelles. Évite les métaphores ou les envolées lyriques. Mots-Clés de Haute Densité : Utilise les termes que les fans taperaient (ex: 'Haki des Rois', 'Fruit du Démon', 'Gear 5', 'Échafaud'). Suppression du Bruit : Ne décris PAS les conséquences à long terme (ex: \"cela change le monde\"), décris uniquement ce qui est visible sur la page. Zéro Technique : Aucun mot sur le dessin (hachures, angles, traits). Réponds uniquement en JSON.";

async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (reader.result) {
                resolve(reader.result.toString().split(',')[1]);
            } else {
                reject(new Error("Failed to convert blob to base64"));
            }
        };
        reader.readAsDataURL(blob);
    });
}

function handleGeminiError(error) {
    if (error.message?.includes('429') || error.message?.includes('quota') || error.toString().includes('429')) {
        throw new Error("QUOTA_EXCEEDED");
    }
    throw error;
}

export async function analyzeBubble(imageSource, coordinates, apiKey) {
    if (!apiKey) throw new Error("Clé API manquante");

    let blob;
    try {
        blob = await cropImage(imageSource, coordinates);
    } catch (e) {
        console.error("Crop error:", e);
        throw new Error("Erreur lors de la découpe de l'image.");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const base64Data = await blobToBase64(blob);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: "image/jpeg",
        },
    };

    try {
        const result = await model.generateContent([ANALYSIS_PROMPT, imagePart]);
        const response = await result.response;
        const text = response.text();
        return { data: { texte_propose: text.trim() } };
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini API Error:", error);
    }
}

export async function generatePageDescription(imageSource, apiKey) {
    if (!apiKey) throw new Error("Clé API manquante");

    let blob;
    try {
        const fullRect = {
            x: 0,
            y: 0,
            w: imageSource.naturalWidth,
            h: imageSource.naturalHeight
        };
        blob = await cropImage(imageSource, fullRect);
    } catch (e) {
        console.error("Image processing error:", e);
        throw new Error("Erreur lors du traitement de l'image.");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: "gemini-3-flash-preview",
        generationConfig: { responseMimeType: "application/json" }
    });

    const base64Data = await blobToBase64(blob);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: "image/jpeg",
        },
    };

    try {
        const result = await model.generateContent([DESCRIPTION_PROMPT, imagePart]);
        const response = await result.response;
        const text = response.text();
        return { data: JSON.parse(text) };
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini API Description Error:", error);
    }
}

export async function rerankSearchResults(results, query, apiKey) {
    if (!apiKey) throw new Error("Clé API manquante");
    if (!results || results.length === 0) return [];

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const documents = results.map((r) => ({
        id: r.id,
        content: r.content,
        context: r.context
    }));

    const prompt = `
    Expert One Piece. Score les candidats pour : "${query}"

Règles de notation AGRESSIVES (Polarise les résultats) :

90-100 (L'ÉLU) : Personnage + Action exacts.

70-85 (PROCHE) : Très forte ressemblance thématique.

45-60 (DOUTE) : Lien partiel ou incertain.

<40 (SANCTION) : Mauvaise action (max 30), mauvais personnage (max 20), ou simple décor (0).

Instruction : Isole l'élu du bruit. Sois impitoyable sur les erreurs de personnage/action. Output : UNIQUEMENT un JSON minifié [{"i":id,"s":score}]. Aucune prose.

Candidats : ${JSON.stringify(documents)}
    `;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Clean up markdown if Gemini adds it
        const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();

        let rankedIds;
        try {
            rankedIds = JSON.parse(jsonStr);
        } catch (e) {
            console.error("Failed to parse Gemini rerank response:", text);
            return results;
        }

        if (!Array.isArray(rankedIds)) return results;

        // Reconstruct the sorted array
        const sortedResults = [];
        const resultMap = new Map(results.map(r => [r.id, r]));

        rankedIds.forEach(id => {
            if (resultMap.has(id)) {
                sortedResults.push(resultMap.get(id));
                resultMap.delete(id);
            }
        });

        // Add any items not returned by Gemini (fallback)
        resultMap.forEach(item => sortedResults.push(item));

        return sortedResults;

    } catch (error) {
        if (error.message?.includes('429') || error.message?.includes('quota') || error.toString().includes('429')) {
            throw new Error("QUOTA_EXCEEDED");
        }

        console.error("Gemini Rerank Error:", error);
        return results; // Fallback to original order for other errors
    }
}
