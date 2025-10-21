const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');

/**
 * @route   GET /api/search
 * @desc    Recherche textuelle dans les bulles validées
 * @access  Public
 * @query   q (required)
 */
router.get('/', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 3) {
    return res.status(400).json({ error: "Le paramètre de recherche 'q' est requis et doit contenir au moins 3 caractères." });
  }

  try {
    const { data, error } = await supabase.rpc('search_bulles', {
      search_term: q
    });

    if (error) throw error;

    res.status(200).json(data);

  } catch (error) {
    console.error("Erreur lors de la recherche:", error.message);
    res.status(500).json({ error: "Une erreur est survenue sur le serveur." });
  }
});

module.exports = router;