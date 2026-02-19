const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabaseClient');

// Get all mangas
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('mangas')
            .select('*')
            .eq('enabled', true)
            .order('titre', { ascending: true });

        if (error) throw error;

        res.json(data);
    } catch (error) {
        console.error("Erreur mangs:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Get manga by slug
router.get('/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { data, error } = await supabase
            .from('mangas')
            .select('*')
            .eq('slug', slug)
            .eq('enabled', true)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Manga non trouvé" });

        res.json(data);
    } catch (error) {
        console.error("Erreur manga:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

module.exports = router;
