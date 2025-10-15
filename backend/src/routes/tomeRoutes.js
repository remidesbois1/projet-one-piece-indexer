const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');

/**
 * @route   GET /api/tomes
 * @desc    Récupérer la liste de tous les tomes
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tomes')
      .select('id, numero, titre')
      .order('numero', { ascending: true });

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