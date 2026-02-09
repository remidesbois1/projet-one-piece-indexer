const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabaseClient');

router.get('/', async (req, res) => {
  try {
    let { manga } = req.query;
    if (Array.isArray(manga)) manga = manga[0];

    let query = supabase
      .from('tomes')
      .select('id, numero, titre, cover_url, mangas!inner(slug)')
      .order('numero', { ascending: true });

    if (manga) {
      query = query.eq('mangas.slug', manga);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.status(200).json(data);

  } catch (error) {
    console.error("Erreur lors de la récupération des tomes:", error.message);
    res.status(500).json({ error: "Une erreur est survenue sur le serveur." });
  }
});

module.exports = router;