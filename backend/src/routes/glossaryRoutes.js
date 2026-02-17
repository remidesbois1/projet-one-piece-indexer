const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');
const { authMiddleware, roleCheck } = require('../middleware/auth');

router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('glossary')
        .select('*');

    if (error) return res.status(500).json({ error: "Erreur serveur" });
    res.json(data);
});

router.post('/', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    const { aliases } = req.body;
    if (!aliases || !Array.isArray(aliases) || aliases.length === 0) {
        return res.status(400).json({ error: "Au moins un alias est requis." });
    }

    const { data, error } = await supabaseAdmin
        .from('glossary')
        .insert({ aliases })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

router.put('/:id', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    const { id } = req.params;
    const { aliases } = req.body;

    const { data, error } = await supabaseAdmin
        .from('glossary')
        .update({ aliases })
        .eq('id', id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.delete('/:id', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    const { error } = await supabaseAdmin
        .from('glossary')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: "Erreur suppression" });
    res.status(204).send();
});

module.exports = router;
