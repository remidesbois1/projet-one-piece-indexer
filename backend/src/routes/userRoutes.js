const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const supabase = require('../config/supabaseClient');

router.get('/bulles', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    try {
        const { data, error } = await supabase
            .from('bulles')
            .select(`
                id,
                texte_propose,
                statut,
                created_at,
                pages (
                    id, 
                    numero_page,
                    chapitres ( numero, tomes ( numero ) )
                )
            `)
            .eq('id_user_createur', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération de vos soumissions." });
    }
});

module.exports = router;