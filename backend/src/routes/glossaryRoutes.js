const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');
const { authMiddleware, roleCheck } = require('../middleware/auth');

router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('glossary')
        .select('word')
        .order('word', { ascending: true });

    if (error) return res.status(500).json({ error: "Erreur serveur" });
    res.json(data.map(item => item.word));
});

router.post('/', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    const { word } = req.body;
    if (!word) return res.status(400).json({ error: "Mot requis" });

    const { data, error } = await supabaseAdmin
        .from('glossary')
        .insert({ word })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') return res.status(409).json({ error: "Déjà existant" });
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json(data);
});

router.delete('/:word', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    const { error } = await supabaseAdmin
        .from('glossary')
        .delete()
        .eq('word', req.params.word);

    if (error) return res.status(500).json({ error: "Erreur suppression" });
    res.status(204).send();
});

module.exports = router;
