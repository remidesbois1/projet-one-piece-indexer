const express = require('express');
const router = express.Router();
const supabaseAdmin = require('../config/supabaseClient');
const { authMiddleware } = require('../middleware/auth');

router.get('/tome/:tomeId', async (req, res) => {
    const { tomeId } = req.params;

    try {
        const { data: chapitres, error } = await supabaseAdmin
            .from('chapitres')
            .select(`
                id, 
                numero, 
                titre, 
                pages ( statut )
            `)
            .eq('id_tome', tomeId)
            .order('numero', { ascending: true });

        if (error) throw error;

        const chapitresWithStatus = chapitres.map(chap => {
            const pages = chap.pages || [];
            const total = pages.length;

            if (total === 0) {
                return { ...chap, global_status: 'empty' };
            }

            const completedCount = pages.filter(p => p.statut === 'completed').length;

            const inProgressCount = pages.filter(p => ['in_progress', 'pending_review'].includes(p.statut)).length;

            let global_status = 'empty';

            if (completedCount === total) {
                global_status = 'completed';
            } else if (completedCount > 0 || inProgressCount > 0) {
                global_status = 'in_progress';
            }
            const { pages: _, ...chapitreSansPages } = chap;

            return { ...chapitreSansPages, global_status };
        });

        res.status(200).json(chapitresWithStatus);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur lors de la récupération des chapitres." });
    }
});

module.exports = router;