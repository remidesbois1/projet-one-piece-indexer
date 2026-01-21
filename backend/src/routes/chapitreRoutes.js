const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabaseClient');
const { authMiddleware } = require('../middleware/auth');
const { checkStatus } = require('../utils/statusHelpers');

router.get('/tome/:tomeId', async (req, res) => {
    const { tomeId } = req.params;

    console.log('Fetching chapitres for tome:', tomeId);

    try {
        const { data: chapitres, error } = await supabase
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
            const { pages, ...chapitreSansPages } = chap;
            return {
                ...chapitreSansPages,
                global_status: checkStatus(pages)
            };
        });

        res.status(200).json(chapitresWithStatus);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;