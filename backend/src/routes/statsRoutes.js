const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabaseClient');

// Endpoint pour les stats générales
router.get('/summary', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('get_summary_stats');
        if (error) throw error;
        res.status(200).json(data[0]);
    } catch (error) {
        res.status(500).json({ error: "Erreur de récupération des stats." });
    }
});

// Endpoint pour le top des contributeurs
router.get('/top-contributors', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('get_top_contributors', { limit_count: 10 });
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur de récupération des contributeurs." });
    }
});

module.exports = router;