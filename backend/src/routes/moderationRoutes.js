const express = require('express');
const router = express.Router();
const { authMiddleware, roleCheck } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.get('/pages', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('pages')
            .select(`
                id,
                numero_page,
                statut,
                url_image, 
                chapitres (
                    numero,
                    titre,
                    tomes ( numero, titre )
                )
            `)
            .eq('statut', 'pending_review');

        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        console.error("Erreur moderation/pages:", error);
        res.status(500).json({ error: "Erreur lors de la récupération des pages à valider." });
    }
});

router.put('/pages/:id/approve', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabaseAdmin
            .from('pages')
            .update({ statut: 'completed' })
            .eq('id', id)
            .select()
            .single();
            
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        console.error("Erreur approve page:", error);
        res.status(500).json({ error: "Erreur lors de l'approbation de la page." });
    }
});

router.put('/pages/:id/reject', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabaseAdmin
            .from('pages')
            .update({ statut: 'in_progress' })
            .eq('id', id)
            .select()
            .single();
            
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        console.error("Erreur reject page:", error);
        res.status(500).json({ error: "Erreur lors du rejet de la page." });
    }
});

module.exports = router;