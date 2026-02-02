const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabaseClient');
const { GoogleGenerativeAI } = require("@google/generative-ai");

router.get('/', async (req, res) => {
    const { q, page = 1, limit = 10, mode = 'keyword', characters, arc, tome } = req.query;
    const userApiKey = req.headers['x-google-api-key'];
    const serverApiKey = process.env.GOOGLE_API_KEY;
    const effectiveApiKey = userApiKey || serverApiKey;
    const isGuest = !userApiKey && !!serverApiKey;

    if (!q || q.length < 2) return res.status(400).json({ error: "Recherche trop courte" });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let finalResults = [];
    let totalCount = 0;

    const parseCharacters = (chars) => {
        if (!chars) return null;
        if (Array.isArray(chars)) return chars;
        try {
            return JSON.parse(chars);
        } catch {
            return [chars];
        }
    };

    const filterCharacters = parseCharacters(characters);
    const filterArc = arc && arc !== '' ? arc : null;
    const filterTome = tome && tome !== '' ? parseInt(tome) : null;

    try {
        if (mode === 'semantic' && effectiveApiKey) {
            const genAI = new GoogleGenerativeAI(effectiveApiKey);
            const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

            const { embedding } = await embedModel.embedContent(q);

            let query = supabase
                .from('pages')
                .select('id, url_image, description, numero_page, embedding, id_chapitre, chapitres(numero, id_tome, tomes(numero))')
                .not('embedding', 'is', null);

            const { data: allPages, error: pagesError } = await query;
            if (pagesError) throw pagesError;

            let filteredPages = allPages.map(page => ({
                id: page.id,
                url_image: page.url_image,
                description: page.description,
                numero_page: page.numero_page,
                embedding: page.embedding,
                chapitre_numero: page.chapitres?.numero,
                tome_numero: page.chapitres?.tomes?.numero,
                id_tome: page.chapitres?.id_tome
            }));

            if (filterTome) {
                filteredPages = filteredPages.filter(page => page.tome_numero === filterTome);
            }

            if (filterCharacters || filterArc) {
                filteredPages = filteredPages.filter(page => {
                    let desc = page.description;
                    try {
                        if (typeof desc === 'string') desc = JSON.parse(desc);
                    } catch (e) {
                        return false;
                    }

                    if (!desc?.metadata) return false;

                    if (filterCharacters && filterCharacters.length > 0) {
                        const pageChars = desc.metadata.characters || [];
                        const hasCharacter = filterCharacters.some(char =>
                            pageChars.some(pc => pc.toLowerCase().includes(char.toLowerCase()))
                        );
                        if (!hasCharacter) return false;
                    }

                    if (filterArc) {
                        const pageArc = desc.metadata.arc || "";
                        if (!pageArc.toLowerCase().includes(filterArc.toLowerCase())) {
                            return false;
                        }
                    }

                    return true;
                });
            }

            if (filteredPages.length === 0) {
                return res.json({ results: [], totalCount: 0 });
            }

            const calculateCosineSimilarity = (vec1, vec2) => {
                let dotProduct = 0;
                let norm1 = 0;
                let norm2 = 0;
                for (let i = 0; i < vec1.length; i++) {
                    dotProduct += vec1[i] * vec2[i];
                    norm1 += vec1[i] * vec1[i];
                    norm2 += vec2[i] * vec2[i];
                }
                return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
            };

            const candidates = filteredPages
                .map(page => {
                    let pageEmbedding = page.embedding;
                    if (typeof pageEmbedding === 'string') {
                        try {
                            pageEmbedding = JSON.parse(pageEmbedding);
                        } catch (e) {
                            console.error('[ERROR] Failed to parse embedding for page', page.id);
                            return null;
                        }
                    }

                    const similarity = calculateCosineSimilarity(embedding.values, pageEmbedding);
                    return {
                        ...page,
                        similarity
                    };
                })
                .filter(page => page !== null && page.similarity >= 0.60)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, 6);

            if (!candidates?.length) return res.json({ results: [], totalCount: 0 });

            if (isGuest) {
                finalResults = candidates.map(c => {
                    let snippet = c.description;
                    try {
                        if (typeof snippet === 'string') snippet = JSON.parse(snippet).content;
                        else if (typeof snippet === 'object') snippet = snippet.content;
                    } catch (e) { }

                    return {
                        type: 'semantic',
                        id: `page-${c.id}`,
                        page_id: c.id,
                        url_image: c.url_image,
                        content: snippet || "",
                        context: `Tome ${c.tome_numero} - Chap. ${c.chapitre_numero} - Page ${c.numero_page}`,
                        scores: { ai: 0, vector: Math.round(c.similarity * 100) },
                        similarity: c.similarity
                    };
                });
                totalCount = finalResults.length;
            } else {
                const rerankModel = genAI.getGenerativeModel({
                    model: "gemini-2.5-flash-lite",
                    generationConfig: { responseMimeType: "application/json" }
                });

                const candidatesForAI = candidates.map(c => {
                    let desc = c.description;
                    try {
                        if (typeof desc === 'string') desc = JSON.parse(desc);
                    } catch (e) { }

                    const content = typeof desc === 'object'
                        ? `${desc.content || ""} (Persos: ${desc.metadata?.characters?.join(', ')})`
                        : String(desc);

                    return { id: c.id, text: content.substring(0, 400) };
                });

                const promptTemplate = process.env.SEARCH_PROMPT;

                const prompt = promptTemplate
                    .replace('{{query}}', q)
                    .replace('{{candidates}}', JSON.stringify(candidatesForAI));

                let scores = [];
                try {
                    const result = await rerankModel.generateContent(prompt);
                    scores = JSON.parse(result.response.text());
                } catch (err) {
                    scores = candidates.map(c => ({ i: c.id, s: c.similarity * 100 }));
                }

                finalResults = candidates.map(c => {
                    const aiData = scores.find(s => s.i === c.id);
                    const finalScore = aiData ? aiData.s : 0;

                    let snippet = c.description;
                    try {
                        if (typeof snippet === 'string') snippet = JSON.parse(snippet).content;
                        else if (typeof snippet === 'object') snippet = snippet.content;
                    } catch (e) { }

                    return {
                        type: 'semantic',
                        id: `page-${c.id}`,
                        page_id: c.id,
                        url_image: c.url_image,
                        content: snippet || "",
                        context: `Tome ${c.tome_numero} - Chap. ${c.chapitre_numero} - Page ${c.numero_page}`,
                        scores: { ai: finalScore, vector: Math.round(c.similarity * 100) },
                        similarity: finalScore / 100
                    };
                })
                    .filter(r => r.scores.ai >= 75)
                    .sort((a, b) => b.scores.ai - a.scores.ai)
                    .slice(0, parseInt(limit));

                totalCount = finalResults.length;
            }
        } else {
            const { data, error } = await supabase.rpc('search_bulles', {
                search_term: q,
                page_limit: 10000,
                page_offset: 0
            });
            if (error) throw error;

            let filteredData = data || [];

            if (filterTome) {
                filteredData = filteredData.filter(b => b.tome_numero === filterTome);
            }

            if (filterCharacters || filterArc) {
                const pageIds = filteredData.map(b => b.page_id);
                if (pageIds.length > 0) {
                    const { data: pagesData } = await supabase
                        .from('pages')
                        .select('id, description')
                        .in('id', pageIds)
                        .not('description', 'is', null);

                    const validPageIds = new Set();
                    (pagesData || []).forEach(page => {
                        let desc = page.description;
                        try {
                            if (typeof desc === 'string') desc = JSON.parse(desc);
                        } catch (e) {
                            return;
                        }

                        if (!desc?.metadata) return;

                        let isValid = true;

                        if (filterCharacters && filterCharacters.length > 0) {
                            const pageChars = desc.metadata.characters || [];
                            const hasCharacter = filterCharacters.some(char =>
                                pageChars.some(pc => pc.toLowerCase().includes(char.toLowerCase()))
                            );
                            if (!hasCharacter) isValid = false;
                        }

                        if (isValid && filterArc) {
                            const pageArc = desc.metadata.arc || "";
                            if (!pageArc.toLowerCase().includes(filterArc.toLowerCase())) {
                                isValid = false;
                            }
                        }

                        if (isValid) validPageIds.add(page.id);
                    });

                    filteredData = filteredData.filter(b => validPageIds.has(b.page_id));
                }
            }

            totalCount = filteredData.length;
            const paginatedData = filteredData.slice(offset, offset + parseInt(limit));

            finalResults = paginatedData.map(b => ({
                type: 'bubble',
                id: b.id,
                page_id: b.page_id,
                url_image: b.url_image,
                coords: { x: b.x, y: b.y, w: b.w, h: b.h },
                content: b.texte_propose,
                context: `Tome ${b.tome_numero} - Chap. ${b.chapitre_numero} - Page ${b.numero_page}`
            }));
        }

        res.json({ results: finalResults, totalCount });

    } catch (error) {
        console.error("Erreur moteur de recherche:", error);
        res.status(500).json({ error: "Erreur moteur de recherche" });
    }
});

router.post('/feedback', async (req, res) => {
    const { query, doc_id, doc_text, is_relevant, model_provider } = req.body;

    try {
        const { error } = await supabase
            .from('search_feedback')
            .insert({
                query,
                doc_id: doc_id ? parseInt(String(doc_id).replace('page-', ''), 10) : null,
                doc_text,
                is_relevant,
                model_provider: model_provider || 'unknown',
            });

        if (error) {
            console.error("Feedback insert error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Feedback server error:", err);
        res.status(500).json({ error: "Internal Error" });
    }
});

module.exports = router;
