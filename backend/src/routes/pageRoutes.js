const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');

router.get('/', async (req, res) => {
  const { id_chapitre } = req.query;
  if (!id_chapitre) return res.status(400).json({ error: "id_chapitre manquant" });

  const { data, error } = await supabase
    .from('pages')
    .select('id, numero_page, url_image')
    .eq('id_chapitre', id_chapitre)
    .order('numero_page', { ascending: true });

  if (error) return res.status(500).json({ error: "Erreur serveur" });
  res.json(data);
});

module.exports = router;
