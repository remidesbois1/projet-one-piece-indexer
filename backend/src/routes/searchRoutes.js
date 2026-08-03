const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');

const { generateVoyageEmbedding, rerankVoyage } = require('../utils/voyageClient');
const { generateGeminiEmbedding } = require('../utils/geminiClient');
const {
    VALIDATED_BUBBLE_STATUS,
    getPageImagePath,
    keepValidatedBubbleRows,
} = require('../utils/publicMedia');
const {
    buildCandidateTokenQueries,
    buildInformativeTokens,
    normalizeQueryBubbles,
    rankOcrPageCandidates,
} = require('../utils/ocrPageSearch');
const {
    f2llmSearchBodySchema,
    ocrSearchBodySchema,
    searchContextQuerySchema,
    searchQuerySchema,
    validateRequest,
} = require('../validation/requestSchemas');

const DUAL_OVERLAP_BONUS = 1.15;
const OCR_CANDIDATE_TOKEN_LIMIT = 12;
const OCR_CANDIDATE_QUERY_LIMIT = 56;
const OCR_CANDIDATE_PAGES_PER_TOKEN = 1200;
const OCR_MAX_CANDIDATE_PAGES = 3500;

async function getUserFromReq(req) {
    try {
        const auth = req.headers.authorization;
        if (!auth) return {};
        const token = auth.replace('Bearer ', '');
        const { data: { user } } = await supabase.auth.getUser(token);
        if (!user) return {};
        return { user_id: user.id, user_email: user.email };
    } catch { return {}; }
}

async function insertSearchLog(log) {
    try {
        await supabaseAdmin.from('search_logs').insert(log);
    } catch (err) {
        console.error('Failed to insert search log:', err.message);
    }
}

function parseCharacters(chars) {
    if (!chars) return null;
    if (Array.isArray(chars)) return chars;
    try {
        return JSON.parse(chars);
    } catch {
        return [chars];
    }
}

function chunkArray(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

function getNestedPageMeta(page) {
    const chapitre = Array.isArray(page.chapitres) ? page.chapitres[0] : page.chapitres;
    const tome = Array.isArray(chapitre?.tomes) ? chapitre.tomes[0] : chapitre?.tomes;
    const manga = Array.isArray(tome?.mangas) ? tome.mangas[0] : tome?.mangas;
    return { chapitre, tome, manga };
}

function pageMatchesMetadataFilters(page, filterCharacters, filterArc) {
    if (!filterCharacters && !filterArc) return true;

    let desc = page.description;
    try {
        if (typeof desc === 'string') desc = JSON.parse(desc);
    } catch {
        return false;
    }
    if (!desc?.metadata) return false;

    if (filterCharacters && filterCharacters.length > 0) {
        const pageChars = desc.metadata.characters || [];
        if (!filterCharacters.some(char =>
            pageChars.some(pc => String(pc).toLowerCase().includes(String(char).toLowerCase()))
        )) return false;
    }

    if (filterArc) {
        const pageArc = desc.metadata.arc || "";
        if (!pageArc.toLowerCase().includes(filterArc.toLowerCase())) return false;
    }

    return true;
}

function formatSemanticPageResult(c) {
    let snippet = c.description;
    try {
        if (typeof snippet === 'string') snippet = JSON.parse(snippet).content;
        else if (typeof snippet === 'object') snippet = snippet.content;
    } catch (e) { }

    return {
        type: 'semantic',
        id: `page-${c.id}`,
        page_id: c.id,
        url_image: getPageImagePath(c.id),
        content: snippet || "",
        context: `Tome ${c.tome_numero} - Chap. ${c.chapitre_numero} - Page ${c.numero_page}`,
        scores: { ai: 0, vector: Math.round(c.similarity * 100), local: Math.round(c.similarity * 100) },
        similarity: c.similarity,
        sources: ['f2llm-browser-ft'],
    };
}

async function runF2llmVectorSearch({ req, query, embedding, page = 1, limit = 10, characters, arc, tome }) {
    if (!query || query.length < 2) {
        const err = new Error("Recherche trop courte");
        err.statusCode = 400;
        throw err;
    }

    if (!Array.isArray(embedding) || embedding.length !== 640 || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        const err = new Error("Embedding F2LLM client invalide");
        err.statusCode = 400;
        throw err;
    }

    const filterCharacters = parseCharacters(characters);
    const filterArc = arc && arc !== '' ? arc : null;
    const filterTome = tome && tome !== '' ? parseInt(tome) : null;
    const filterManga = req.validated?.query?.manga || null;
    const totalStart = Date.now();
    const userInfo = await getUserFromReq(req);
    const searchLog = {
        raw_query: query,
        model_provider: 'f2llm-browser-ft',
        search_mode: 'semantic',
        manga_slug: filterManga || null,
        filter_characters: filterCharacters,
        filter_arc: filterArc,
        filter_tome: filterTome,
        rerank_enabled: false,
        ...userInfo,
    };

    const rpcStart = Date.now();
    const { data, error } = await supabaseAdmin.rpc('match_pages_f2llm', {
        query_embedding: embedding,
        match_threshold: 0.30,
        match_count: 50,
    });
    searchLog.duration_f2llm_rpc_ms = Date.now() - rpcStart;
    if (error) throw error;

    let filteredPages = data || [];
    searchLog.f2llm_candidates_count = filteredPages.length;

    if (filterManga) {
        filteredPages = filteredPages.filter(p => p.manga_slug === filterManga);
    }
    if (filterTome) {
        filteredPages = filteredPages.filter(p => p.tome_numero === filterTome);
    }
    if (filterCharacters || filterArc) {
        filteredPages = filteredPages.filter(page => pageMatchesMetadataFilters(page, filterCharacters, filterArc));
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const finalResults = filteredPages.slice(offset, offset + parseInt(limit)).map(formatSemanticPageResult);
    const totalCount = filteredPages.length;

    searchLog.merged_candidates_count = filteredPages.length;
    searchLog.final_results_count = finalResults.length;
    if (finalResults.length > 0) {
        searchLog.top_result_id = finalResults[0].page_id;
        searchLog.top_result_score = finalResults[0].scores.vector;
    }
    searchLog.duration_total_ms = Date.now() - totalStart;
    insertSearchLog(searchLog);

    return { results: finalResults, totalCount };
}

async function findCandidatePageIdsFromTokenQueries(tokenQueries) {
    const pageScores = new Map();

    for (const query of tokenQueries.slice(0, OCR_CANDIDATE_QUERY_LIMIT)) {
        const term = typeof query === 'string' ? query : query.term;
        const weight = typeof query === 'string' ? Math.max(1, query.length / 5) : query.weight;
        if (!term) continue;

        const { data, error } = await supabaseAdmin
            .from('bulles')
            .select('id_page')
            .eq('statut', VALIDATED_BUBBLE_STATUS)
            .ilike('texte_propose', `%${term}%`)
            .limit(OCR_CANDIDATE_PAGES_PER_TOKEN);

        if (error) throw error;

        for (const row of data || []) {
            if (!row.id_page) continue;
            pageScores.set(row.id_page, (pageScores.get(row.id_page) || 0) + weight);
        }
    }

    return Array.from(pageScores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, OCR_MAX_CANDIDATE_PAGES)
        .map(([pageId]) => pageId);
}

async function fetchCandidatePages(pageIds) {
    if (!pageIds.length) return [];

    const pages = [];
    for (const chunk of chunkArray(pageIds, 250)) {
        const { data, error } = await supabaseAdmin
            .from('pages')
            .select(`
                id,
                numero_page,
                url_image,
                description,
                chapitres (
                    numero,
                    tomes (
                        numero,
                        mangas (
                            slug
                        )
                    )
                ),
                bulles (
                    id,
                    id_page,
                    texte_propose,
                    x,
                    y,
                    w,
                    h,
                    statut,
                    order
                )
            `)
            .in('id', chunk);

        if (error) throw error;
        pages.push(...(data || []).map((page) => ({
            ...page,
            bulles: (page.bulles || []).filter(
                (bubble) => bubble.statut === VALIDATED_BUBBLE_STATUS
            ),
        })));
    }

    return pages;
}

function formatOcrPageResult(pageRecord, provider) {
    const { chapitre, tome: pageTome } = getNestedPageMeta(pageRecord);
    const content = pageRecord.matches?.length
        ? pageRecord.matches.map(match => match.matched_text).join(' / ')
        : '';

    return {
        type: 'ocr',
        id: `page-${pageRecord.id}`,
        page_id: pageRecord.id,
        url_image: getPageImagePath(pageRecord.id),
        content,
        context: `Tome ${pageTome?.numero ?? '?'} - Chap. ${chapitre?.numero ?? '?'} - Page ${pageRecord.numero_page}`,
        scores: {
            ocr: Math.round(pageRecord.score * 100),
            text: Math.round((pageRecord.scoreBreakdown?.text || 0) * 100),
            layout: Math.round((pageRecord.scoreBreakdown?.layout || 0) * 100),
        },
        similarity: pageRecord.score,
        ocr: {
            provider,
            matched_count: pageRecord.scoreBreakdown?.matched_count || 0,
            query_count: pageRecord.scoreBreakdown?.query_count || 0,
            matches: pageRecord.matches || [],
        },
    };
}

router.post('/ocr-match', validateRequest({ body: ocrSearchBodySchema, query: searchContextQuerySchema }), async (req, res) => {
    const {
        bubbles,
        page,
        limit,
        manga,
        characters,
        arc,
        tome,
        provider,
        raw_text,
    } = req.validated.body;

    const queryBubbles = normalizeQueryBubbles(bubbles);
    if (!queryBubbles.some(bubble => bubble.content)) {
        return res.status(400).json({ error: "Aucun texte OCR exploitable dans l'image." });
    }

    const filterCharacters = parseCharacters(characters);
    const filterArc = arc && arc !== 'all' ? arc : null;
    const filterTome = tome || null;
    const filterManga = manga || req.validated.query.manga || null;
    const parsedLimit = limit;
    const parsedPage = page;
    const offset = (parsedPage - 1) * parsedLimit;
    const totalStart = Date.now();
    const userInfo = await getUserFromReq(req);

    const searchLog = {
        raw_query: raw_text || queryBubbles.map(bubble => bubble.content).join('\n'),
        model_provider: provider,
        search_mode: 'ocr',
        manga_slug: filterManga,
        filter_characters: filterCharacters,
        filter_arc: filterArc,
        filter_tome: filterTome,
        rerank_enabled: false,
        ...userInfo,
    };

    try {
        const tokenStart = Date.now();
        const informativeTokens = buildInformativeTokens(queryBubbles);
        const tokenQueries = buildCandidateTokenQueries(queryBubbles, OCR_CANDIDATE_TOKEN_LIMIT);
        searchLog.duration_normalization_ms = Date.now() - tokenStart;

        const candidateStart = Date.now();
        const candidatePageIds = await findCandidatePageIdsFromTokenQueries(tokenQueries);
        searchLog.merged_candidates_count = candidatePageIds.length;
        const candidateLookupMs = Date.now() - candidateStart;

        if (!candidatePageIds.length) {
            searchLog.final_results_count = 0;
            searchLog.duration_total_ms = Date.now() - totalStart;
            insertSearchLog(searchLog);
            return res.json({
                results: [],
                totalCount: 0,
                ocr: {
                    provider,
                    queryBubblesCount: queryBubbles.length,
                    candidatePagesCount: 0,
                    rankedPagesCount: 0,
                    topScore: 0,
                },
            });
        }

        const fetchStart = Date.now();
        let candidatePages = await fetchCandidatePages(candidatePageIds);
        const candidateFetchMs = Date.now() - fetchStart;

        candidatePages = candidatePages.filter(pageRecord => {
            const { chapitre, tome: pageTome, manga: pageManga } = getNestedPageMeta(pageRecord);
            if (filterManga && pageManga?.slug !== filterManga) return false;
            if (filterTome && Number(pageTome?.numero) !== filterTome) return false;
            if (!pageMatchesMetadataFilters(pageRecord, filterCharacters, filterArc)) return false;
            return Boolean(chapitre && pageTome);
        });

        const rankStart = Date.now();
        const rankedPages = rankOcrPageCandidates(queryBubbles, candidatePages, {
            limit: OCR_MAX_CANDIDATE_PAGES,
        });
        searchLog.duration_merge_ms = candidateLookupMs + candidateFetchMs + (Date.now() - rankStart);

        const topOcrScore = rankedPages[0]?.score || 0;
        const ocrResults = rankedPages.map(pageRecord => formatOcrPageResult(pageRecord, provider));
        const finalResults = ocrResults.slice(offset, offset + parsedLimit);

        searchLog.final_results_count = finalResults.length;
        if (finalResults.length > 0) {
            searchLog.top_result_id = finalResults[0].page_id;
            searchLog.top_result_score = finalResults[0].scores.ocr ?? Math.round((finalResults[0].similarity || 0) * 100);
        }
        searchLog.duration_total_ms = Date.now() - totalStart;
        insertSearchLog(searchLog);

        res.json({
            results: finalResults,
            totalCount: ocrResults.length,
            ocr: {
                provider,
                queryBubblesCount: queryBubbles.length,
                candidatePagesCount: candidatePageIds.length,
                rankedPagesCount: rankedPages.length,
                topScore: topOcrScore,
                tokens: informativeTokens,
                candidateQueries: tokenQueries.slice(0, OCR_CANDIDATE_QUERY_LIMIT).map(query => query.term),
            },
        });
    } catch (error) {
        console.error("Erreur recherche OCR:", error);
        searchLog.error = error.message;
        searchLog.duration_total_ms = Date.now() - totalStart;
        insertSearchLog(searchLog);
        res.status(500).json({ error: "Erreur recherche OCR" });
    }
});

router.post('/f2llm-local', validateRequest({ body: f2llmSearchBodySchema, query: searchContextQuerySchema }), async (req, res) => {
    try {
        const {
            query,
            embedding,
            page,
            limit,
            characters,
            arc,
            tome,
        } = req.validated.body;

        const result = await runF2llmVectorSearch({
            req,
            query,
            embedding,
            page,
            limit,
            characters,
            arc,
            tome,
        });

        return res.json(result);
    } catch (err) {
        console.error("F2LLM browser search error:", err);
        return res.status(err.statusCode || 500).json({ error: err.message || "Erreur recherche F2LLM" });
    }
});

router.get('/', validateRequest({ query: searchQuerySchema }), async (req, res) => {
    const { q, page, limit, mode, characters, arc, tome, rerank, local_only, localOnly: legacyLocalOnly, manga } = req.validated.query;
    const shouldRerank = rerank;
    const localOnly = local_only ?? legacyLocalOnly ?? false;

    const offset = (page - 1) * limit;
    let finalResults = [];
    let totalCount = 0;

    const filterCharacters = parseCharacters(characters);
    const filterArc = arc && arc !== '' ? arc : null;
    const filterTome = tome || null;

    const userInfo = await getUserFromReq(req);
    const searchLog = {
        raw_query: q,
        model_provider: mode === 'semantic' && localOnly ? 'f2llm-local' : 'dual',
        search_mode: mode,
        manga_slug: manga || null,
        filter_characters: filterCharacters,
        filter_arc: filterArc,
        filter_tome: filterTome,
        rerank_enabled: shouldRerank,
        ...userInfo,
    };

    const totalStart = Date.now();

    try {
        if (mode === 'semantic') {
            const candidatesQueryLimit = shouldRerank ? Math.max(24, limit) : limit;
            const filterManga = manga;

            if (localOnly) {
                return res.status(400).json({
                    error: "Local Only doit envoyer un embedding F2LLM calculé dans le navigateur via POST /api/search/f2llm-local."
                });
            }

            let voyageEmbedMs = 0, geminiEmbedMs = 0, voyageRpcMs = 0, geminiRpcMs = 0;

            // Always run BOTH engines in parallel
            const [voyageResults, geminiResults] = await Promise.all([
                (async () => {
                    const embStart = Date.now();
                    const embedding = await generateVoyageEmbedding(q, "query");
                    voyageEmbedMs = Date.now() - embStart;

                    const rpcStart = Date.now();
                    const { data, error } = await supabaseAdmin.rpc('match_pages', {
                        query_embedding: embedding,
                        match_threshold: 0.30,
                        match_count: 50,
                    });
                    voyageRpcMs = Date.now() - rpcStart;
                    if (error) throw error;
                    return data || [];
                })(),
                (async () => {
                    try {
                        const embStart = Date.now();
                        // For query embedding, we only send text (no image for the query)
                        const embedding = await generateGeminiEmbedding(q, "RETRIEVAL_QUERY");
                        geminiEmbedMs = Date.now() - embStart;

                        const rpcStart = Date.now();
                        const { data, error } = await supabaseAdmin.rpc('match_pages_gemini', {
                            query_embedding: embedding,
                            match_threshold: 0.30,
                            match_count: 50,
                        });
                        geminiRpcMs = Date.now() - rpcStart;
                        if (error) throw error;
                        return data || [];
                    } catch (geminiError) {
                        console.error('[Search] Gemini search failed, continuing with Voyage only:', geminiError.message);
                        return [];
                    }
                })()
            ]);

            searchLog.duration_voyage_embedding_ms = voyageEmbedMs;
            searchLog.duration_gemini_embedding_ms = geminiEmbedMs;
            searchLog.duration_voyage_rpc_ms = voyageRpcMs;
            searchLog.duration_gemini_rpc_ms = geminiRpcMs;
            searchLog.voyage_candidates_count = voyageResults.length;
            searchLog.gemini_candidates_count = geminiResults.length;

            // Merge results from both engines
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

            let matchedPages = Array.from(pageMap.values()).sort((a, b) => b.similarity - a.similarity);

            // Apply filters
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
                        url_image: getPageImagePath(c.id),
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
                    // Use Voyage reranking by default (faster, more reliable)
                    const results = await rerankVoyage(q, documents);
                    scores = results.map(r => ({
                        i: candidates[r.index].id,
                        s: r.relevance_score * 100
                    }));
                } catch (err) {
                    console.error(`Rerank error, falling back to vector similarity:`, err);
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
                        url_image: getPageImagePath(c.id),
                        content: snippet || "",
                        context: `Tome ${c.tome_numero} - Chap. ${c.chapitre_numero} - Page ${c.numero_page}`,
                        scores: { ai: finalScore, vector: Math.round(c.similarity * 100) },
                        similarity: finalScore / 100
                    };
                })
                    .filter(r => r.scores.ai >= 70)
                    .sort((a, b) => b.scores.ai - a.scores.ai)
                    .slice(0, limit);

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
            const { data, error } = await supabaseAdmin.rpc('search_bulles', {
                search_term: q,
                page_limit: 10000,
                page_offset: 0
            });
            if (error) throw error;

            let filteredData = await keepValidatedBubbleRows(supabaseAdmin, data || []);

            const filterManga = manga;
            if (filterManga) {
                const pageIds = filteredData.map(b => b.page_id);
                if (pageIds.length > 0) {
                    const { data: pagesMangaData, error: mangaError } = await supabaseAdmin
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
                    const { data: pagesData } = await supabaseAdmin
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
            const paginatedData = filteredData.slice(offset, offset + limit);

            finalResults = paginatedData.map(b => ({
                type: 'bubble',
                id: b.id,
                page_id: b.page_id,
                url_image: getPageImagePath(b.page_id),
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

module.exports = router;
