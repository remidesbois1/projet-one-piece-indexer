import { GoogleGenerativeAI } from "@google/generative-ai";
import { cropImage } from "./utils";

const ANALYSIS_PROMPT = "Tu es un expert en numérisation de manga. Ta tâche est de transcrire le texte présent dans cette bulle de dialogue.  Règles strictes : 1. Transcris EXACTEMENT le texte visible (OCR). 2. Corrige automatiquement les erreurs mineures d'OCR. 3. Rétablis la casse naturelle. 4. Ne traduis pas. Reste en Français. 5. Renvoie UNIQUEMENT le texte final.";

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

    const base64Data = await new Promise((resolve, reject) => {
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
        console.error("Gemini API Error:", error);
        throw error;
    }
}
