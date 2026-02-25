const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_RERANK_MODEL = 'gemini-2.5-flash-lite';

async function generateGeminiEmbedding(text, taskType = "RETRIEVAL_QUERY") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        throw new Error('GOOGLE_API_KEY is not defined in environment variables.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_EMBED_MODEL });

    try {
        const result = await model.embedContent({
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: 3072
        });

        const embedding = result.embedding;
        if (embedding && embedding.values) {
            return embedding.values;
        } else {
            throw new Error('No embedding array returned from Gemini API.');
        }
    } catch (error) {
        console.error('Error generating Gemini embedding:', error.message);
        throw error;
    }
}

async function normalizeQuery(query, userApiKey) {
    const apiKey = userApiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey) return query;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: GEMINI_RERANK_MODEL,
        systemInstruction: `Tu es un expert en indexation One Piece. Ta mission est de transformer la requête de l'utilisateur en une version normalisée optimisée pour la recherche vectorielle.
Règles :
Remplace les noms français par les noms officiels (ex: Hermep -> Helmeppo, Kobby -> Koby, Pipo -> Usopp).
Corrige l'orthographe.
Conserve les verbes d'action.
Réponds UNIQUEMENT par la nouvelle requête, sans phrase ni ponctuation inutile.`
    });

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: query }] }],
            generationConfig: { temperature: 0.0, maxOutputTokens: 50 }
        });
        const normalized = result.response.text().trim();
        return normalized || query;
    } catch (error) {
        console.error('normalizeQuery error, using raw query:', error.message);
        return query;
    }
}

async function rerankGemini(query, candidates, userApiKey) {
    const apiKey = userApiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.warn('rerankGemini: No API key provided, skipping reranking.');
        return candidates.map(c => ({ i: c.id, s: 0 }));
    }

    if (!candidates || candidates.length === 0) return [];

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_RERANK_MODEL });

    const candidatesStr = JSON.stringify(candidates.map(c => ({ id: c.id, text: c.content })));

    const promptText = `Tu es l'expert ultime de One Piece. Ta mission est de retrouver LA page spécifique recherchée par l'utilisateur parmi des candidats imparfaits. Requête utilisateur : "${query}" Règles de notation AGRESSIVES (Polarise tes scores) : 1. **LA PAGE ÉLUE (90-100)** : Correspondance sémantique évidente. Personnage + Action exacte. 2. **LE DOUTE PERMIS (70-85)** : Très forte ressemblance mais pas parfait. 3. **CA POURRAIT, MAIS NON (45-60)** : On pourrait croire, mais pas sûr. 4. **LA SANCTION (< 40)** : - Mauvaise action (ex: cherche "mange", trouve "dort") -> Max 30. - Mauvais personnage -> Max 20. - Décor/Ambiance -> 0. Sois extrêmement agressif. Isole la bonne page du bruit. Renvoie UNIQUEMENT un JSON minifié sans espaces avec les clés "i" (id) et "s" (score) : [{"i":123,"s":95},{"i":456,"s":15}] Candidats : ${candidatesStr}`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            generationConfig: {
                temperature: 0.1,
                topK: 1,
                topP: 1
            }
        });

        const responseText = result.response.text().trim();

        let parsedScores = [];
        try {
            const cleanText = responseText.replace(/```json|```/gi, '').trim();
            const jsonMatch = cleanText.match(/\[.*\]/s);

            if (jsonMatch) {
                parsedScores = JSON.parse(jsonMatch[0]);
            } else {
                parsedScores = JSON.parse(cleanText);
            }

            if (!Array.isArray(parsedScores)) {
                if (parsedScores !== null && typeof parsedScores === 'object') {
                    if ('i' in parsedScores && 's' in parsedScores) {
                        parsedScores = [parsedScores];
                    } else {
                        const arrayValue = Object.values(parsedScores).find(val => Array.isArray(val));
                        if (arrayValue) {
                            parsedScores = arrayValue;
                        } else {
                            throw new Error("No array found in parsed JSON");
                        }
                    }
                } else {
                    throw new Error("Parsed JSON is not an array or object");
                }
            }
        } catch (parseError) {
            console.warn("Failed to parse Gemini reranker JSON output:", responseText, parseError.message);
            parsedScores = candidates.map(c => ({ i: c.id, s: 0 }));
        }

        return parsedScores;

    } catch (error) {
        console.error('Error reranking with Gemini:', error.message);
        throw error;
    }
}

module.exports = { generateGeminiEmbedding, rerankGemini, normalizeQuery };
