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
  const { q, page = 1, limit = 10 } = req.query;

  if (!q || q.length < 3) {
    return res.status(400).json({ error: "La recherche doit contenir au moins 3 caractères." });
  }

  const pageInt = parseInt(page);
  const limitInt = parseInt(limit);
  const offset = (pageInt - 1) * limitInt;

  try {
    const { data, error } = await supabase.rpc('search_bulles', {
      search_term: q,
      page_limit: limitInt,
      page_offset: offset
    });

    if (error) throw error;

    res.status(200).json({
        results: data,
        totalCount: data.length > 0 ? data[0].total_count : 0
    });

  } catch (error) {
    console.error("Erreur lors de la recherche:", error.message);
    res.status(500).json({ error: "Une erreur est survenue sur le serveur." });
  }
});

module.exports = router;