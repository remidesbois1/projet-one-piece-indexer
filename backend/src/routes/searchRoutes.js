const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');

const { generateVoyageEmbedding, rerankVoyage } = require('../utils/voyageClient');

const AI_MODEL_KEYS = ['model_ocr', 'model_description'];
const DEFAULT_MODELS = {
    model_ocr: 'gemini-2.5-flash-lite',
    model_description: 'gemini-3-flash-preview'
};
let aiModelsCache = null;
let aiModelsCacheTime = 0;
const CACHE_TTL = 60 * 1000;

async function getAiModels() {
    const now = Date.now();
    if (aiModelsCache && (now - aiModelsCacheTime) < CACHE_TTL) return aiModelsCache;
    const { data, error } = await supabaseAdmin.from('app_settings').select('key, value').in('key', AI_MODEL_KEYS);
    if (error) return { ...DEFAULT_MODELS };
    const models = { ...DEFAULT_MODELS };
    (data || []).forEach(row => { models[row.key] = row.value; });
    aiModelsCache = models;
    aiModelsCacheTime = now;
    return models;
}

let glossaryCache = null;
let glossaryCacheTime = 0;

async function getGlossary() {
    const now = Date.now();
    if (glossaryCache && (now - glossaryCacheTime) < CACHE_TTL * 5) return glossaryCache;
    const { data } = await supabase.from('glossary').select('aliases');
    glossaryCache = (data || []).map(r => r.aliases).filter(a => Array.isArray(a) && a.length > 1);
    glossaryCacheTime = now;
    return glossaryCache;
}

async function enrichQueryWithGlossary(query) {
    const glossary = await getGlossary();
    const words = query.split(/\s+/);
    const result = [];

    for (const word of words) {
        result.push(word);
        const lower = word.toLowerCase();
        for (const group of glossary) {
            if (group.some(alias => alias.toLowerCase() === lower)) {
                group.forEach(alias => {
                    if (alias.toLowerCase() !== lower) result.push(alias);
                });
                break;
            }
        }
    }

    return result.join(' ');
}

router.get('/', async (req, res) => {
    const { q, page = 1, limit = 10, mode = 'keyword', characters, arc, tome, rerank } = req.query;
    const shouldRerank = rerank === 'true';

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
        if (mode === 'semantic') {
            const enrichedQuery = await enrichQueryWithGlossary(q);
            const embedding = await generateVoyageEmbedding(enrichedQuery, "query");
            const candidatesQueryLimit = shouldRerank ? Math.max(50, parseInt(limit)) : parseInt(limit);
            const filterManga = req.query.manga;

            const { data: matchedPages, error: matchError } = await supabase.rpc('match_pages', {
                query_embedding: embedding,
                match_threshold: 0.30,
                match_count: 200,
            });
            if (matchError) throw matchError;

            let filteredPages = matchedPages || [];

            if (filterManga) {
                filteredPages = filteredPages.filter(p => p.manga_slug === filterManga);
            }
            if (filterTome) {
                filteredPages = filteredPages.filter(p => p.tome_numero === filterTome);
            }
            if (filterCharacters || filterArc) {
                filteredPages = filteredPages.filter(page => {
                    let desc = page.description;
                    try {
                        if (typeof desc === 'string') desc = JSON.parse(desc);
                    } catch (e) { return false; }
                    if (!desc?.metadata) return false;

                    if (filterCharacters && filterCharacters.length > 0) {
                        const pageChars = desc.metadata.characters || [];
                        if (!filterCharacters.some(char =>
                            pageChars.some(pc => pc.toLowerCase().includes(char.toLowerCase()))
                        )) return false;
                    }
                    if (filterArc) {
                        const pageArc = desc.metadata.arc || "";
                        if (!pageArc.toLowerCase().includes(filterArc.toLowerCase())) return false;
                    }
                    return true;
                });
            }

            const candidates = filteredPages.slice(0, candidatesQueryLimit);

            if (!candidates.length) return res.json({ results: [], totalCount: 0 });

            if (!shouldRerank) {
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
                const documents = candidates.map(c => {
                    let desc = c.description;
                    try {
                        if (typeof desc === 'string') desc = JSON.parse(desc);
                    } catch (e) { }

                    const content = typeof desc === 'object'
                        ? `${desc.content || ""} (Persos: ${desc.metadata?.characters?.join(', ')})`
                        : String(desc);
                    return content;
                });

                let scores = [];
                try {
                    const results = await rerankVoyage(q, documents);
                    scores = results.map(r => ({
                        i: candidates[r.index].id,
                        s: r.relevance_score * 100
                    }));
                } catch (err) {
                    console.error("Voyage rerank error, falling back to vector similarity:", err);
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
                    .filter(r => r.scores.ai >= 70)
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

            const filterManga = req.query.manga;
            if (filterManga) {
                const pageIds = filteredData.map(b => b.page_id);
                if (pageIds.length > 0) {
                    const { data: pagesMangaData, error: mangaError } = await supabase
                        .from('pages')
                        .select('id, chapitres!inner(tomes!inner(mangas!inner(slug)))')
                        .in('id', pageIds);

                    if (!mangaError && pagesMangaData) {
                        const validPageIds = new Set(
                            pagesMangaData
                                .filter(p => p.chapitres?.tomes?.mangas?.slug === filterManga)
                                .map(p => p.id)
                        );
                        filteredData = filteredData.filter(b => validPageIds.has(b.page_id));
                    }
                }
            }

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
