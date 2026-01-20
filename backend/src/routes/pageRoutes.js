const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const { authMiddleware } = require('../middleware/auth');

router.get('/', async (req, res) => {
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
        .select('id, numero_page, url_image')
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
    const { data, error } = await supabase
        .from('pages')
        .update({ statut: 'pending_review' })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: "Erreur soumission" });
    res.json(data);
});

module.exports = router;
