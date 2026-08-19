import { GoogleGenerativeAI } from "@google/generative-ai";
import { cropImage } from "./utils";
import { capitalizeOcrSentenceStarts } from './ocr-utils';
import { getAiModelConfig } from './aiModelConfig';
import { getPrompt } from './promptConfig';

export function getGeminiGenerationConfig(config, overrides = {}) {
    const level = config?.gemini_thinking_level || 'default';
    if (level === 'default') return overrides;

    const thinkingConfig = level === 'none'
        ? { thinkingBudget: 0 }
        : { thinkingLevel: level.toUpperCase() };
    return { ...overrides, thinkingConfig };
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

    const repairMissingClosers = (value) => {
        if (!value.startsWith('{') && !value.startsWith('[')) return null;
        const stack = [];
        let inString = false;
        let escaped = false;
        for (const character of value) {
            if (inString) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') inString = false;
                continue;
            }
            if (character === '"') inString = true;
            else if (character === '{') stack.push('}');
            else if (character === '[') stack.push(']');
            else if (character === '}' || character === ']') {
                if (stack.pop() !== character) return null;
            }
        }
        return inString || !stack.length ? null : `${value}${stack.reverse().join('')}`;
    };

    try {
        return JSON.parse(candidate);
    } catch (directError) {
        const repaired = repairMissingClosers(candidate);
        if (repaired) {
            try {
                return JSON.parse(repaired);
            } catch {
                // Continue with the existing extraction paths for non-trivial malformed output.
            }
        }
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

function unwrapGeminiEnvelope(data) {
    if (Array.isArray(data?.chapters)) return data;
    const parts = data?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || [];
    const text = parts.find((part) => typeof part?.text === 'string' && part.text.trim())?.text;
    return text ? parseModelJson(text, 'Sommaire Gemini') : data;
}

export function normalizeVolumeSummaryChapters(data, pageCount) {
    const chapters = Array.isArray(data?.chapters) ? data.chapters : [];
    const normalized = chapters
        .map((chapter) => {
            const number = Number.parseInt(chapter?.number, 10);
            const startPage = Number.parseInt(chapter?.start_page ?? chapter?.startPage, 10);
            const title = typeof chapter?.title === 'string' ? chapter.title.trim() : '';
            const printedPage = Number.parseInt(chapter?.printed_page ?? chapter?.printedPage, 10);
            if (!Number.isInteger(number) || number < 1) return null;
            if (!Number.isInteger(startPage) || startPage < 1 || startPage > pageCount) return null;
            return {
                number,
                title: title || `Chapitre ${number}`,
                startPage,
                printedPage: Number.isInteger(printedPage) && printedPage > 0 ? printedPage : null,
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.startPage - right.startPage || left.number - right.number);

    const hasDuplicateOrReverseStart = normalized.some(
        (chapter, index) => index > 0 && chapter.startPage <= normalized[index - 1].startPage,
    );
    if (!normalized.length || hasDuplicateOrReverseStart) {
        throw new Error('Sommaire Gemini invalide : aucune liste de débuts de chapitres exploitable.');
    }
    return normalized;
}

export function parseVolumeSummaryResponse(responseText, pageCount) {
    const raw = unwrapGeminiEnvelope(parseModelJson(responseText, 'Sommaire Gemini'));
    return {
        chapters: normalizeVolumeSummaryChapters(raw, pageCount),
        raw,
    };
}

export async function analyzeVolumeSummary(imageBlob, { pageCount, summaryPage }, apiKey) {
    if (!apiKey) throw new Error("Clé API Gemini manquante.");
    if (!imageBlob) throw new Error("Image du sommaire manquante.");
    if (!Number.isInteger(pageCount) || pageCount < 1 || !Number.isInteger(summaryPage) || summaryPage < 1) {
        throw new Error('Contexte de pagination du sommaire invalide.');
    }

    const config = await getAiModelConfig();
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: config.model_ocr,
        generationConfig: getGeminiGenerationConfig(config, { responseMimeType: "application/json" }),
    });
    const base64Data = await blobToBase64(imageBlob);
    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: imageBlob.type || "image/jpeg",
        },
    };

    try {
        const prompt = (await getPrompt('volume_summary'))
            .replaceAll('{pageCount}', String(pageCount))
            .replaceAll('{summaryPage}', String(summaryPage));
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        return parseVolumeSummaryResponse(response.text(), pageCount);
    } catch (error) {
        handleGeminiError(error);
        console.error('Gemini summary analysis error:', error);
        throw error;
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
    const model = genAI.getGenerativeModel({
        model: config.model_ocr,
        generationConfig: getGeminiGenerationConfig(config),
    });

    const base64Data = await blobToBase64(blob);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: "image/jpeg",
        },
    };

    try {
        const result = await model.generateContent([await getPrompt('ocr_bubble'), imagePart]);
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
        generationConfig: getGeminiGenerationConfig(config, { responseMimeType: "application/json" })
    });

    const base64Data = await blobToBase64(blob);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: "image/jpeg",
        },
    };

    try {
        const prompt = `${await getPrompt('page_description')}\n\n${await getPrompt('strict_json_suffix')}`;
        const result = await model.generateContent([prompt, imagePart]);
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
    const config = await getAiModelConfig();

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
        model: config.model_ocr,
        generationConfig: getGeminiGenerationConfig(config, { responseMimeType: "application/json" })
    });

    const base64Data = await blobToBase64(blob);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: "image/jpeg",
        },
    };

    try {
        const prompt = `${await getPrompt('ocr_page_bbox')}\n\n${await getPrompt('strict_json_suffix')}`;
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const candidates = response.candidates;
        let data;
        if (candidates?.[0]?.content?.parts) {
            const answerPart = candidates[0].content.parts.find(p => !p.thought && p.text);
            data = parseModelJson((answerPart || candidates[0].content.parts.find(p => p.text)).text, "One-shot Gemini");
        } else {
            data = parseModelJson(response.text(), "One-shot Gemini");
        }
        return { data: normalizeGeneratedBubbles(data), model: config.model_ocr };
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
        generationConfig: getGeminiGenerationConfig(config, { responseMimeType: "application/json" })
    });

    const base64Data = await blobToBase64(imageBlob);
    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: imageBlob.type || "image/jpeg",
        },
    };

    try {
        const prompt = `${await getPrompt('ocr_page_bbox')}\n\n${await getPrompt('strict_json_suffix')}`;
        const result = await model.generateContent([prompt, imagePart]);
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
