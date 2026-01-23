const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');

let cache = {
    data: null,
    timestamp: 0
};
const TTL = 1000 * 60 * 60;
let pendingRequest = null;

router.get('/landing', async (req, res) => {
    const now = Date.now();

    if (cache.data && (now - cache.timestamp < TTL)) {
        return res.status(200).json(cache.data);
    }

    if (pendingRequest) {
        try {
            const data = await pendingRequest;
            return res.status(200).json(data);
        } catch (err) {
            if (cache.data) return res.status(200).json(cache.data);
            return res.status(500).json({ error: "Cache wait error." });
        }
    }

    pendingRequest = (async () => {
        try {
            const [chapters, pages] = await Promise.all([
                supabaseAdmin.from('chapitres').select('*', { count: 'exact', head: true }),
                supabaseAdmin.from('pages').select('*', { count: 'exact', head: true })
            ]);

            if (chapters.error) throw chapters.error;
            if (pages.error) throw pages.error;

            const { data: bubbles, error: bubblesError } = await supabaseAdmin
                .from('bulles')
                .select('texte_propose')
                .not('texte_propose', 'is', null)
                .neq('texte_propose', '');

            if (bubblesError) throw bubblesError;

            let totalWords = 0;
            if (bubbles) {
                for (const bubble of bubbles) {
                    if (bubble.texte_propose) {
                        totalWords += bubble.texte_propose.trim().split(/\s+/).length;
                    }
                }
            }

            const newData = {
                chapters: chapters.count,
                pages: pages.count,
                bubbles: bubbles ? bubbles.length : 0,
                words: totalWords
            };

            cache = {
                data: newData,
                timestamp: Date.now()
            };

            return newData;
        } finally {
            pendingRequest = null;
        }
    })();

    try {
        const data = await pendingRequest;
        res.status(200).json(data);
    } catch (error) {
        if (cache.data) {
            return res.status(200).json(cache.data);
        }
        res.status(500).json({ error: "Stats retrieval error." });
    }
});

router.get('/summary', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('get_summary_stats');
        if (error) throw error;
        res.status(200).json(data[0]);
    } catch (error) {
        res.status(500).json({ error: "Retrieval error." });
    }
});

router.get('/top-contributors', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('get_top_contributors', { limit_count: 10 });
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Retrieval error." });
    }
});

module.exports = router;