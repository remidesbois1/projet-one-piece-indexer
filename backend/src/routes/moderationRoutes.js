const express = require('express');
const router = express.Router();
const { authMiddleware, roleCheck } = require('../middleware/auth');


const { supabaseAdmin } = require('../config/supabaseClient');

router.get('/pages', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('pages')
        .select(`
            id, numero_page, statut, url_image, created_at,
            chapitres ( numero, titre, tomes ( numero, titre ) )
        `)
        .eq('statut', 'pending_review');

    if (error) return res.status(500).json({ error: 'Db error' });
    res.json(data);
});

router.put('/pages/approve-all', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('pages')
            .update({ statut: 'completed' })
            .eq('statut', 'pending_review')
            .select();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Erreur approval global pages:", error);
        res.status(500).json({ error: 'Update failed' });
    }
});

router.put('/pages/:id/approve', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('pages')
        .update({ statut: 'completed' })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: 'Update failed' });
    res.json(data);
});

router.put('/pages/:id/reject', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { comment } = req.body;
    const { data, error } = await supabaseAdmin
        .from('pages')
        .update({
            statut: 'in_progress',
            commentaire_moderation: comment || null
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: 'Update failed' });
    res.json(data);
});

module.exports = router;
