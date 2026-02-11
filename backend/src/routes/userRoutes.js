const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabaseClient');

router.get('/bulles', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 10, manga } = req.query;
    const pageInt = parseInt(page);
    const limitInt = parseInt(limit);
    const rangeStart = (pageInt - 1) * limitInt;
    const rangeEnd = rangeStart + limitInt - 1;

    try {
        let query = supabaseAdmin
            .from('bulles')
            .select(`
                id, texte_propose, statut, created_at, commentaire_moderation,
                pages!inner ( 
                    id, numero_page, 
                    chapitres!inner ( 
                        numero, 
                        tomes!inner ( 
                            numero,
                            mangas!inner ( slug, titre )
                        ) 
                    ) 
                )
            `, { count: 'exact' })
            .eq('id_user_createur', userId);

        if (manga) {
            query = query.eq('pages.chapitres.tomes.mangas.slug', manga);
        }

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(rangeStart, rangeEnd);

        if (error) throw error;
        res.status(200).json({
            results: data,
            totalCount: count
        });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération de vos soumissions." });
    }
});

module.exports = router;