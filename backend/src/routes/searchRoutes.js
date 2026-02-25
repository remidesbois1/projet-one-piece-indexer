const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');

const { generateVoyageEmbedding, rerankVoyage } = require('../utils/voyageClient');
const { generateGeminiEmbedding, rerankGemini, normalizeQuery } = require('../utils/geminiClient');

const DUAL_OVERLAP_BONUS = 1.15;

function getUserFromReq(req) {
    try {
        const auth = req.headers.authorization;
        if (!auth) return {};
        const token = auth.replace('Bearer ', '');
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return { user_id: payload.sub, user_email: payload.email };
    } catch { return {}; }
}

async function insertSearchLog(log) {
    try {
        await supabaseAdmin.from('search_logs').insert(log);
    } catch (err) {
        console.error('Failed to insert search log:', err.message);
    }
}

router.get('/', async (req, res) => {
    const { q, page = 1, limit = 10, mode = 'keyword', characters, arc, tome, rerank, modelProvider = 'voyage' } = req.query;
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

    const searchLog = {
        raw_query: q,
        model_provider: modelProvider,
        search_mode: mode,
        manga_slug: req.query.manga || null,
        filter_characters: filterCharacters,
        filter_arc: filterArc,
        filter_tome: filterTome,
        rerank_enabled: shouldRerank,
        ...getUserFromReq(req),
    };

    const totalStart = Date.now();

    try {
        if (mode === 'semantic') {
            const userGeminiKey = req.headers['x-user-gemini-key'];
            const candidatesQueryLimit = shouldRerank ? Math.max(24, parseInt(limit)) : parseInt(limit);
            const filterManga = req.query.manga;

            let matchedPages;

            if (modelProvider === 'gemini') {
                if (!userGeminiKey) {
                    return res.status(403).json({ error: "Une clé API Gemini est requise pour utiliser le moteur Gemini." });
                }

                const normStart = Date.now();
                const cleanQuery = await normalizeQuery(q, userGeminiKey);
                searchLog.duration_normalization_ms = Date.now() - normStart;
                searchLog.normalized_query = cleanQuery;
                console.log(`[Search] Query normalized: "${q}" → "${cleanQuery}" (${searchLog.duration_normalization_ms}ms)`);

                let voyageEmbedMs = 0, geminiEmbedMs = 0, voyageRpcMs = 0, geminiRpcMs = 0;

                const [voyageResults, geminiResults] = await Promise.all([
                    (async () => {
                        const embStart = Date.now();
                        const embedding = await generateVoyageEmbedding(cleanQuery, "query");
                        voyageEmbedMs = Date.now() - embStart;

                        const rpcStart = Date.now();
                        const { data, error } = await supabase.rpc('match_pages', {
                            query_embedding: embedding,
                            match_threshold: 0.30,
                            match_count: 50,
                        });
                        voyageRpcMs = Date.now() - rpcStart;
                        if (error) throw error;
                        return data || [];
                    })(),
                    (async () => {
                        const embStart = Date.now();
                        const embedding = await generateGeminiEmbedding(cleanQuery, "RETRIEVAL_QUERY");
                        geminiEmbedMs = Date.now() - embStart;

                        const rpcStart = Date.now();
                        const { data, error } = await supabase.rpc('match_pages_gemini', {
                            query_embedding: embedding,
                            match_threshold: 0.30,
                            match_count: 50,
                        });
                        geminiRpcMs = Date.now() - rpcStart;
                        if (error) throw error;
                        return data || [];
                    })()
                ]);

                searchLog.duration_voyage_embedding_ms = voyageEmbedMs;
                searchLog.duration_gemini_embedding_ms = geminiEmbedMs;
                searchLog.duration_voyage_rpc_ms = voyageRpcMs;
                searchLog.duration_gemini_rpc_ms = geminiRpcMs;
                searchLog.voyage_candidates_count = voyageResults.length;
                searchLog.gemini_candidates_count = geminiResults.length;

                const mergeStart = Date.now();
                const pageMap = new Map();

                for (const p of voyageResults) {
                    pageMap.set(p.id, { ...p, sources: ['voyage'], bestSimilarity: p.similarity });
                }

                for (const p of geminiResults) {
                    if (pageMap.has(p.id)) {
                        const existing = pageMap.get(p.id);
                        existing.sources.push('gemini');
                        existing.bestSimilarity = Math.max(existing.bestSimilarity, p.similarity);
                    } else {
                        pageMap.set(p.id, { ...p, sources: ['gemini'], bestSimilarity: p.similarity });
                    }
                }

                let overlapCount = 0;
                for (const [id, entry] of pageMap) {
                    if (entry.sources.length > 1) {
                        entry.similarity = Math.min(entry.bestSimilarity * DUAL_OVERLAP_BONUS, 1.0);
                        overlapCount++;
                    } else {
                        entry.similarity = entry.bestSimilarity;
                    }
                }

                searchLog.dual_overlap_count = overlapCount;
                searchLog.merged_candidates_count = pageMap.size;
                searchLog.duration_merge_ms = Date.now() - mergeStart;

                matchedPages = Array.from(pageMap.values()).sort((a, b) => b.similarity - a.similarity);
            } else {
                const embStart = Date.now();
                const embedding = await generateVoyageEmbedding(q, "query");
                searchLog.duration_voyage_embedding_ms = Date.now() - embStart;

                const rpcStart = Date.now();
                const { data, error } = await supabase.rpc('match_pages', {
                    query_embedding: embedding,
                    match_threshold: 0.30,
                    match_count: 50,
                });
                searchLog.duration_voyage_rpc_ms = Date.now() - rpcStart;
                if (error) throw error;
                matchedPages = data || [];
                searchLog.voyage_candidates_count = matchedPages.length;
            }

            let filteredPages = matchedPages;

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

            if (!candidates.length) {
                searchLog.final_results_count = 0;
                searchLog.duration_total_ms = Date.now() - totalStart;
                insertSearchLog(searchLog);
                return res.json({ results: [], totalCount: 0 });
            }

            if (!shouldRerank && modelProvider !== 'gemini') {
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
                const rerankStart = Date.now();
                try {
                    if (modelProvider === 'gemini') {
                        const results = await rerankGemini(q, candidates.map((c, idx) => ({ id: c.id, content: documents[idx] })), userGeminiKey);
                        scores = results.map(r => ({
                            i: typeof r.i === 'string' && r.i.startsWith('page-') ? parseInt(r.i.replace('page-', ''), 10) : r.i,
                            s: typeof r.s === 'number' ? r.s : parseFloat(r.s) || 0
                        }));
                    } else {
                        const results = await rerankVoyage(q, documents);
                        scores = results.map(r => ({
                            i: candidates[r.index].id,
                            s: r.relevance_score * 100
                        }));
                    }
                } catch (err) {
                    console.error(`${modelProvider} rerank error, falling back to vector similarity:`, err);
                    scores = candidates.map(c => ({ i: c.id, s: c.similarity * 100 }));
                }
                searchLog.duration_rerank_ms = Date.now() - rerankStart;

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

            searchLog.final_results_count = finalResults.length;
            if (finalResults.length > 0) {
                searchLog.top_result_id = finalResults[0].page_id;
                searchLog.top_result_score = finalResults[0].scores.ai || finalResults[0].scores.vector;
            }
            searchLog.duration_total_ms = Date.now() - totalStart;
            insertSearchLog(searchLog);

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
        searchLog.error = error.message;
        searchLog.duration_total_ms = Date.now() - totalStart;
        insertSearchLog(searchLog);
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
