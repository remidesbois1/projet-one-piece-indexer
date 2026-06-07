const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabaseClient');
const { authMiddleware, roleCheck } = require('../middleware/auth');
const { createPublicPreviewImage } = require('../utils/protectedImage');
const axios = require('axios');

router.get('/', async (req, res) => {
    console.log('GET pages', req.query);
    const { id_chapitre } = req.query;
    if (!id_chapitre) return res.status(400).json({ error: "id_chapitre manquant" });

    const { data, error } = await supabase
        .from('pages')
        .select('id, numero_page, url_image, statut')
        .eq('id_chapitre', id_chapitre)
        .order('numero_page', { ascending: true });

    if (error) return res.status(500).json({ error: "Erreur serveur" });
    res.json(data);
});

router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('pages')
        .select('*, chapitres(numero, tomes(numero))')
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(500).json({ error: "Erreur serveur" });
    if (!data) return res.status(404).json({ error: "Page non trouvée" });
    res.json(data);
});

router.get('/:id/bulles', async (req, res) => {
    const { data, error } = await supabase
        .from('bulles')
        .select('id, x, y, w, h, texte_propose, statut, id_user_createur, order')
        .eq('id_page', req.params.id)
        .neq('statut', 'Rejeté');

    if (error) return res.status(500).json({ error: "Erreur fetch bulles" });
    res.json(data);
});

router.put('/:id/submit-review', authMiddleware, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('pages')
        .update({ statut: 'pending_review' })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: "Erreur soumission" });
    res.json(data);
});

router.put('/:id/status', authMiddleware, roleCheck(['Admin']), async (req, res) => {
    const { statut } = req.body;
    const allowedStatuses = ['not_started', 'in_progress', 'pending_review', 'completed'];

    if (!allowedStatuses.includes(statut)) {
        return res.status(400).json({ error: "Statut invalide" });
    }

    const updatePayload = { statut };
    if (statut !== 'in_progress') updatePayload.commentaire_moderation = null;

    const { data, error } = await supabaseAdmin
        .from('pages')
        .update(updatePayload)
        .eq('id', req.params.id)
        .select('*, chapitres(numero, tomes(numero))')
        .single();

    if (error) return res.status(500).json({ error: "Erreur mise à jour statut" });
    res.json(data);
});

router.get('/:id/image', async (req, res) => {
    const { id } = req.params;
    const token = req.query.token;

    try {
        const { data: page, error } = await supabase
            .from('pages')
            .select('url_image')
            .eq('id', id)
            .single();

        if (error || !page) return res.status(404).json({ error: "Page non trouvée" });

        let isAuthenticated = false;
        if (token) {
            const { data: { user }, error: authError } = await supabase.auth.getUser(token);
            if (!authError && user) isAuthenticated = true;
        }

        const imageResponse = await axios({
            url: page.url_image,
            responseType: 'arraybuffer'
        });
        const imageBuffer = Buffer.from(imageResponse.data, 'binary');

        if (isAuthenticated) {
            res.set('Content-Type', 'image/avif');
            res.set('Cache-Control', 'public, max-age=3600');
            return res.send(imageBuffer);
        }

        const { data: bubbles, error: bubblesError } = await supabase
            .from('bulles')
            .select('x, y, w, h')
            .eq('id_page', id)
            .neq('statut', 'Rejeté');

        if (bubblesError) throw bubblesError;

        const protectedImageBuffer = await createPublicPreviewImage(imageBuffer, bubbles);

        res.set('Content-Type', 'image/avif');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(protectedImageBuffer);

    } catch (err) {
        console.error("Erreur service image:", err);
        res.status(500).json({ error: "Erreur lors du traitement de l'image" });
    }
});

module.exports = router;
