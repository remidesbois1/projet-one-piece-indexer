import { GoogleGenerativeAI } from "@google/generative-ai";
import { cropImage } from "./utils";
import { capitalizeOcrSentenceStarts } from './ocr-utils';

const ANALYSIS_PROMPT = "Tu es un expert en numérisation de manga. Ta tâche est de transcrire le texte présent dans cette bulle de dialogue.  Règles strictes : 1. Transcris EXACTEMENT le texte visible (OCR). 2. Corrige automatiquement les erreurs mineures d'OCR. 3. Rétablis la casse naturelle. 4. Ne traduis pas. Reste en Français. 5. Renvoie UNIQUEMENT le texte final.";

const DESCRIPTION_PROMPT = "Analyse cette page de One Piece. Ton but est de générer un objet JSON optimisé pour la similarité cosinus. La description doit être dense, directe et centrée sur l'action principale pour maximiser les scores de correspondance. Schéma de sortie attendu : JSON { \"content\": \"Action principale. Détails de l'événement et contexte immédiat. Éléments de lore.\", \"metadata\": { \"arc\": \"Nom de l'arc\", \"characters\": [\"Liste des personnages\"] } } Règles de rédaction pour 'content' (Priorité Recherche) : Accroche Directe : Commence la première phrase par l'action ou l'événement exact (ex: \"Exécution de Gol D. Roger\" ou \"Combat entre Luffy et Kaido\"). C'est ce qui \"ancre\" le vecteur. Sujet-Verbe-Complément : Utilise des phrases simples et factuelles. Évite les métaphores ou les envolées lyriques. Mots-Clés de Haute Densité : Utilise les termes que les fans taperaient (ex: 'Haki des Rois', 'Fruit du Démon', 'Gear 5', 'Échafaud'). Suppression du Bruit : Ne décris PAS les conséquences à long terme (ex: \"cela change le monde\"), décris uniquement ce qui est visible sur la page. Zéro Technique : Aucun mot sur le dessin (hachures, angles, traits). Réponds uniquement en JSON.";

const STRICT_JSON_SUFFIX = "La reponse doit etre un objet JSON brut et valide. Elle doit commencer par { et finir par }. N'ajoute aucun markdown, aucune puce, aucun commentaire, aucun libelle Input/Output.";

const PAGE_OCR_BBOX_PROMPT = `Tu es un moteur OCR de page/crop de manga.
Extrais uniquement les textes visibles dans les bulles, cartouches ou onomatopees lisibles, avec leur bbox.
Renvoie un JSON strict:
{
  "bubbles": [
    { "content": "texte exact", "bbox": [x1, y1, x2, y2] }
  ]
}
Regles:
- Coordonnees normalisees entre 0 et 1000 dans le repere de l'image fournie.
- Ordre de lecture japonais: haut droite vers bas gauche.
- Garde le francais, ne traduis pas.
- Corrige seulement les erreurs OCR evidentes de ponctuation/casse.
- Ignore les bulles vides ou illisibles.
- N'ajoute aucun texte hors JSON.`;

const COOKIE_NAME = 'ai_models';
const COOKIE_TTL = 5 * 60 * 1000;

function getCachedModels() {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
    if (!match) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(match[1]));
        if (parsed._ts && (Date.now() - parsed._ts) < COOKIE_TTL) {
            return parsed;
        }
        return null;
    } catch { return null; }
}

function setCachedModels(models) {
    if (typeof document === 'undefined') return;
    const payload = { ...models, _ts: Date.now() };
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(payload))}; path=/; max-age=${COOKIE_TTL / 1000}; SameSite=Lax`;
}

const DEFAULT_MODELS = {
    model_ocr: 'gemini-2.5-flash-lite',
    model_description: 'gemini-3-flash-preview'
};

export async function getAiModelConfig() {
    const cached = getCachedModels();
    if (cached) return cached;

    try {
        const { getPublicAiModels } = await import('./api');
        const res = await getPublicAiModels();
        const models = res.data;
        setCachedModels(models);
        return models;
    } catch {
        return DEFAULT_MODELS;
    }
}

export function invalidateModelCache() {
    if (typeof document === 'undefined') return;
    document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
}

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

function normalizeGeneratedBubbles(data) {
    const rawBubbles = Array.isArray(data)
        ? data
        : Array.isArray(data?.bubbles)
            ? data.bubbles
            : [];

    return rawBubbles
        .map((bubble) => {
            const content = capitalizeOcrSentenceStarts(bubble?.content || bubble?.text || bubble?.texte).trim();
            const rawBox = bubble?.bbox || bubble?.pos || bubble?.box;
            let bbox = null;

            if (Array.isArray(rawBox) && rawBox.length >= 4) {
                bbox = rawBox.slice(0, 4).map(Number);
            } else if (rawBox && typeof rawBox === 'object') {
                const x = Number(rawBox.x ?? rawBox.x1);
                const y = Number(rawBox.y ?? rawBox.y1);
                const w = Number(rawBox.w);
                const h = Number(rawBox.h);
                const x2 = Number(rawBox.x2);
                const y2 = Number(rawBox.y2);
                bbox = Number.isFinite(w) && Number.isFinite(h)
                    ? [x, y, x + w, y + h]
                    : [x, y, x2, y2];
            }

            if (!content || !bbox?.every(Number.isFinite)) return null;
            return { content, bbox };
        })
        .filter(Boolean);
}

function handleGeminiError(error) {
    if (error.message?.includes('429') || error.message?.includes('quota') || error.toString().includes('429')) {
        throw new Error("QUOTA_EXCEEDED");
    }
    throw error;
}

function parseModelJson(text, context = "Gemini") {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${context}: reponse vide.`);
    }

    const trimmed = text.trim();
    const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fencedJson ? fencedJson[1].trim() : trimmed;

    try {
        return JSON.parse(candidate);
    } catch (directError) {
        const firstObject = candidate.indexOf('{');
        const lastObject = candidate.lastIndexOf('}');
        const firstArray = candidate.indexOf('[');
        const lastArray = candidate.lastIndexOf(']');

        const objectSlice = firstObject !== -1 && lastObject > firstObject
            ? candidate.slice(firstObject, lastObject + 1)
            : null;
        const arraySlice = firstArray !== -1 && lastArray > firstArray
            ? candidate.slice(firstArray, lastArray + 1)
            : null;

        for (const jsonSlice of [objectSlice, arraySlice]) {
            if (!jsonSlice) continue;
            try {
                return JSON.parse(jsonSlice);
            } catch {
                // Try the next likely JSON block before surfacing the original failure.
            }
        }

        const preview = trimmed.replace(/\s+/g, ' ').slice(0, 140);
        throw new Error(`${context}: reponse non JSON (${directError.message}). Apercu: ${preview}`);
    }
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

    const config = await getAiModelConfig();
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: config.model_ocr });

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

    const config = await getAiModelConfig();
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: config.model_description,
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
        const result = await model.generateContent([`${DESCRIPTION_PROMPT}\n\n${STRICT_JSON_SUFFIX}`, imagePart]);
        const response = await result.response;
        const text = response.text();
        return { data: parseModelJson(text, "Description Gemini") };
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini API Description Error:", error);
        throw error;
    }
}

export async function generateGeminiEmbedding(text, imageSource, apiKey) {
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

    const base64Data = await blobToBase64(blob);

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: {
                    parts: [
                        { text: text },
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: base64Data
                            }
                        }
                    ]
                },
                taskType: "RETRIEVAL_DOCUMENT"
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || "Erreur Gemini Embedding");
        }

        const res = await response.json();
        return res.embedding.values;
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini Embedding Error:", error);
        throw error;
    }
}

export async function generateGeminiImageEmbedding(imageBlob, apiKey) {
    if (!apiKey) throw new Error("Cle API manquante");
    if (!imageBlob) throw new Error("Image manquante");

    const base64Data = await blobToBase64(imageBlob);

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: {
                    parts: [
                        {
                            inlineData: {
                                mimeType: imageBlob.type || "image/jpeg",
                                data: base64Data
                            }
                        }
                    ]
                },
                taskType: "RETRIEVAL_QUERY"
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || "Erreur Gemini Embedding");
        }

        const res = await response.json();
        return res.embedding.values;
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini Image Embedding Error:", error);
        throw error;
    }
}

export async function generateOneShotBubbles(imageSource, apiKey) {
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
        model: "gemma-4-26b-a4b-it",
        generationConfig: {
            responseMimeType: "application/json"/*,
            thinkingConfig: {
                thinkingBudget: 800
            }*/
        }
    });

    const base64Data = await blobToBase64(blob);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: "image/jpeg",
        },
    };

    const prompt = `à partir de cette page, extrait tout le texte de chaque bulle dans le bon ordre de lecture japonais (en haut à droite -> en bas à gauche) Avec leurs position bbox. Dans un format json :
[
  {
    "content": "texte",
    "pos": [ymin, xmin, ymax, xmax]
  }
]
- Corrige aussi la casse : "TRES BIEN, ..." devient : "Très bien, ..."
Position normalisé à 1000 que tu va re-normaliser derrière selon la page.`;

    try {
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const candidates = response.candidates;
        if (candidates?.[0]?.content?.parts) {
            const answerPart = candidates[0].content.parts.find(p => !p.thought && p.text);
            if (answerPart) {
                return { data: parseModelJson(answerPart.text, "One-shot Gemini") };
            }
        }
        return { data: parseModelJson(response.text(), "One-shot Gemini") };
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini API One-Shot Error:", error);
        throw error;
    }
}

export async function generatePageOcrBboxes(imageBlob, apiKey) {
    if (!apiKey) throw new Error("Cle API manquante");
    if (!imageBlob) throw new Error("Image manquante");

    const config = await getAiModelConfig();
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: config.model_ocr,
        generationConfig: { responseMimeType: "application/json" }
    });

    const base64Data = await blobToBase64(imageBlob);
    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: imageBlob.type || "image/jpeg",
        },
    };

    try {
        const result = await model.generateContent([`${PAGE_OCR_BBOX_PROMPT}\n\n${STRICT_JSON_SUFFIX}`, imagePart]);
        const response = await result.response;
        const data = parseModelJson(response.text(), "OCR recherche Gemini");
        return {
            data: {
                bubbles: normalizeGeneratedBubbles(data),
                raw: data,
            }
        };
    } catch (error) {
        handleGeminiError(error);
        console.error("Gemini OCR Search Error:", error);
        throw error;
    }
}
