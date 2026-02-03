const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/supabaseClient');

let cachedBannedIps = new Set();
let lastInfoFetch = 0;
const CACHE_TTL = 60 * 1000;

async function refreshBannedIps() {
    const now = Date.now();
    if (now - lastInfoFetch < CACHE_TTL && cachedBannedIps.size > 0) return;

    try {
        const { data, error } = await supabase.from('banned_ips').select('ip');
        if (!error && data) {
            cachedBannedIps = new Set(data.map(r => r.ip));
            lastInfoFetch = now;
        }
    } catch (e) {
        console.error("Failed to refresh banned IPs", e);
    }
}

const ipHandler = async (req, res, next) => {
    let ip = req.headers['cf-connecting-ip'] ||
        (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
        req.ip ||
        req.connection.remoteAddress;

    if (ip && ip.includes('::ffff:')) ip = ip.split('::ffff:')[1];

    if (Date.now() - lastInfoFetch >= CACHE_TTL) {
        refreshBannedIps();
    }

    if (cachedBannedIps.has(ip)) {
        console.warn(`[Blocked] Request from banned IP: ${ip}`);
        return res.status(403).json({ error: "Access denied." });
    }

    req.clientIp = ip;
    next();
};

router.use(ipHandler);


/**
 * GET /v1/status
 * Check API status
 */
router.get('/status', (req, res) => {
    res.json({
        status: 'online',
        message: 'One Piece Indexer Public API v1',
        your_ip: req.clientIp
    });
});

/**
 * GET /v1/tomes
 * List all available tomes
 */
router.get('/tomes', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('tomes')
            .select('id, numero, titre, cover_url')
            .order('numero', { ascending: true });

        if (error) throw error;

        res.json({
            data: data,
            meta: { count: data.length }
        });
    } catch (error) {
        console.error("Public API Error (tomes):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /v1/tomes/:tomeNumero/chapters
 * List chapters for a specific tome
 */
router.get('/tomes/:tomeNumero/chapters', async (req, res) => {
    const { tomeNumero } = req.params;

    try {
        const { data: tome, error: tomeError } = await supabase
            .from('tomes')
            .select('id')
            .eq('numero', tomeNumero)
            .single();

        if (tomeError || !tome) {
            return res.status(404).json({ error: "Tome not found" });
        }

        const { data: chapters, error } = await supabase
            .from('chapitres')
            .select('id, numero, titre')
            .eq('id_tome', tome.id)
            .order('numero', { ascending: true });

        if (error) throw error;

        res.json({
            tome: parseInt(tomeNumero),
            data: chapters,
            meta: { count: chapters.length }
        });
    } catch (error) {
        console.error("Public API Error (chapters):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /v1/search
 * Simple keyword search for bubbles
 * Query params: 
 *  - q: query string
 *  - limit: number (max 50)
 */
router.get('/search', async (req, res) => {
    const { q, limit = 20 } = req.query;

    if (!q || q.length < 2) {
        return res.status(400).json({ error: "Query 'q' is required (min 2 chars)." });
    }

    const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);

    try {
        const { data, error } = await supabase.rpc('search_bulles', {
            search_term: q,
            page_limit: safeLimit,
            page_offset: 0
        });

        if (error) throw error;

        const results = (data || []).map(b => ({
            id: b.id,
            type: 'bubble',
            content: b.texte_propose,
            url: b.url_image,
            context: {
                tome: b.tome_numero,
                chapter: b.chapitre_numero,
                page: b.numero_page
            }
        }));

        res.json({
            query: q,
            results: results,
            meta: { count: results.length }
        });

    } catch (error) {
        console.error("Public API Error (search):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});



/**
 * GET /v1/stats
 * Global statistics (Tomes, Chapters, Pages, Bubbles)
 */
router.get('/stats', async (req, res) => {
    try {
        const [tomes, chapters, pages, bubbles] = await Promise.all([
            supabase.from('tomes').select('*', { count: 'exact', head: true }),
            supabase.from('chapitres').select('*', { count: 'exact', head: true }),
            supabase.from('pages').select('*', { count: 'exact', head: true }),
            supabase.from('bulles').select('*', { count: 'exact', head: true }).not('texte_propose', 'is', null).neq('texte_propose', '')
        ]);

        res.json({
            tomes: tomes.count,
            chapters: chapters.count,
            pages: pages.count,
            bubbles: bubbles.count,
            last_updated: new Date().toISOString()
        });
    } catch (error) {
        console.error("Public API Error (stats):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /v1/quotes/random
 * Get a random bubble quote
 * Query params:
 *  - min_length: number (delete short interjections, default 15)
 */
router.get('/quotes/random', async (req, res) => {
    const minLength = parseInt(req.query.min_length) || 15;

    try {
        const { count, error: countError } = await supabase
            .from('bulles')
            .select('*', { count: 'exact', head: true })
            .eq('statut', 'Validé')
            .not('texte_propose', 'is', null)
            .neq('texte_propose', '');

        if (countError) throw countError;

        if (count === 0) return res.status(404).json({ error: "No quotes found." });

        const randomOffset = Math.floor(Math.random() * count);

        const { data, error } = await supabase
            .from('bulles')
            .select(`
                id, 
                texte_propose, 
                pages (
                    numero_page, 
                    chapitres (
                        numero, 
                        tomes (
                            numero
                        )
                    )
                )
            `)

            .eq('statut', 'Validé')
            .not('texte_propose', 'is', null)
            .neq('texte_propose', '')
            .range(randomOffset, randomOffset)
            .limit(1)
            .single();

        if (error) throw error;
        if (data.texte_propose.length < minLength) {
            const retryOffset = Math.floor(Math.random() * count);
            const { data: retryData } = await supabase
                .from('bulles')
                .select(`id, texte_propose, pages (numero_page, chapitres(numero, tomes(numero)))`)
                .not('texte_propose', 'is', null)
                .range(retryOffset, retryOffset)
                .single();

            if (retryData && retryData.texte_propose.length >= minLength) {
                return res.json(formatBubble(retryData));
            }
        }

        res.json(formatBubble(data));

    } catch (error) {
        console.error("Public API Error (random):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /v1/chapters/:numero
 * Get specific chapter details with stats
 */
router.get('/chapters/:numero', async (req, res) => {
    const { numero } = req.params;

    try {
        const { data, error } = await supabase
            .from('chapitres')
            .select(`
                id,
                numero,
                titre,
                id_tome,
                tomes ( numero, titre, cover_url ),
                pages (
                    id,
                    bulles ( count )
                )
            `)
            .eq('numero', numero)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: "Chapter not found" });
        }

        const pageCount = data.pages.length;
        const bubbleCount = data.pages.reduce((acc, page) => acc + (page.bulles ? page.bulles[0].count : 0), 0);

        res.json({
            numero: data.numero,
            titre: data.titre,
            tome: {
                numero: data.tomes?.numero,
                titre: data.tomes?.titre,
                cover_url: data.tomes?.cover_url
            },
            stats: {
                pages: pageCount,
                bubbles: bubbleCount
            }
        });

    } catch (error) {
        console.error("Public API Error (chapter detail):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /v1/chapters/:chapterNo/pages/:pageNo
 * Get bubbles for a specific page of a chapter
 */
router.get('/chapters/:chapterNo/pages/:pageNo', async (req, res) => {
    const { chapterNo, pageNo } = req.params;

    try {


        const { data: correctPage, error } = await supabase
            .from('pages')
            .select(`
                id,
                url_image,
                numero_page,
                description,
                chapitres!inner(
                    id,
                    numero,
                    tomes(numero)
                )
            `)
            .eq('chapitres.numero', chapterNo)
            .eq('numero_page', pageNo)
            .single();

        if (error || !correctPage) {
            return res.status(404).json({ error: "Page not found (check chapter and page numbers)" });
        }

        let metadata = { arc: null, characters: [] };
        if (correctPage.description) {
            try {
                let desc = correctPage.description;
                if (typeof desc === 'string') desc = JSON.parse(desc);
                if (desc.metadata) {
                    metadata = desc.metadata;
                }
            } catch (e) { }
        }

        const { data: bubbles, error: bubblesError } = await supabase
            .from('bulles')
            .select('id, texte_propose, order')
            .eq('id_page', correctPage.id)
            .eq('statut', 'Validé')
            .order('order', { ascending: true })
            .order('id', { ascending: true });

        if (bubblesError) throw bubblesError;

        const validBubbles = (bubbles || []).filter(b => b.texte_propose && b.texte_propose.trim() !== '');

        const protocol = req.protocol;
        const host = req.get('host');
        const watermarkedImageUrl = `${protocol}://${host}/api/pages/${correctPage.id}/image`;

        res.json({
            context: {
                tome: correctPage.chapitres?.tomes?.numero,
                chapter: parseInt(chapterNo),
                page: parseInt(pageNo),
                image_url: watermarkedImageUrl
            },
            metadata: metadata,
            bubbles: validBubbles.map(b => ({
                id: b.id,
                content: b.texte_propose,
                order: b.order
            }))
        });

    } catch (error) {
        console.error("Public API Error (page bubbles):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

function formatBubble(b) {
    return {
        id: b.id,
        content: b.texte_propose,
        context: {
            tome: b.pages?.chapitres?.tomes?.numero,
            chapter: b.pages?.chapitres?.numero,
            page: b.pages?.numero_page
        }
    };
}

module.exports = router;
