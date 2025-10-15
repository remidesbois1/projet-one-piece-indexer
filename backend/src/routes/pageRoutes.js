const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');

/**
 * @route   GET /api/pages
 * @desc    Récupérer les pages d'un chapitre spécifique
 * @access  Public
 * @query   id_chapitre (required)
 */
router.get('/', async (req, res) => {
  const { id_chapitre } = req.query;

  if (!id_chapitre) {
    return res.status(400).json({ error: "Le paramètre 'id_chapitre' est manquant." });
  }

  try {
    const { data, error } = await supabase
      .from('pages')
      .select('id, numero_page, url_image')
      .eq('id_chapitre', id_chapitre)
      .order('numero_page', { ascending: true });

    if (error) throw error;

    res.status(200).json(data);

  } catch (error) {
    console.error("Erreur lors de la récupération des pages:", error.message);
    res.status(500).json({ error: "Une erreur est survenue sur le serveur." });
  }
});

module.exports = router;