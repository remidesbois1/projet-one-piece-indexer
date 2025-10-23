const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');

router.get('/', async (req, res) => {
  const { q, page = 1, limit = 10 } = req.query;

  if (!q || q.length < 3) {
    return res.status(400).json({ error: "Recherche trop courte (min 3 chars)" });
  }

  const pageInt = parseInt(page);
  const limitInt = parseInt(limit);
  const offset = (pageInt - 1) * limitInt;

  const { data, error } = await supabase.rpc('search_bulles', {
    search_term: q,
    page_limit: limitInt,
    page_offset: offset
  });

  if (error) return res.status(500).json({ error: "Erreur recherche" });

  res.status(200).json({
      results: data,
      totalCount: data.length > 0 ? data[0].total_count : 0
  });
});

module.exports = router;
