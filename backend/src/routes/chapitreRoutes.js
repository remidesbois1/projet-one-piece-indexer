const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');

/**
 * @route   GET /api/chapitres
 * @desc    Récupérer les chapitres d'un tome spécifique
 * @access  Public
 * @query   id_tome (required)
 */
router.get('/', async (req, res) => {
  const { id_tome } = req.query;

  if (!id_tome) {
    return res.status(400).json({ error: "Le paramètre 'id_tome' est manquant." });
  }

  try {
    const { data, error } = await supabase
      .from('chapitres')
      .select('id, numero, titre')
      .eq('id_tome', id_tome)
      .order('numero', { ascending: true });

    if (error) throw error;

    res.status(200).json(data);

  } catch (error) {
    console.error("Erreur lors de la récupération des chapitres:", error.message);
    res.status(500).json({ error: "Une erreur est survenue sur le serveur." });
  }
});

module.exports = router;