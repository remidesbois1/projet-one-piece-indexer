const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const authMiddleware = require('../middleware/auth');

const callAiMicroservice = async (pageId, coords) => {
  console.log(`(SIMULATION ÉCHEC) Appel au microservice IA pour la page ${pageId}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  return {
    texteOcrBrut: "",
    textePropose: "<REJET>"
  };
};

/**
 * @route   POST /api/bulles
 * @desc    Créer une nouvelle proposition de bulle
 * @access  Privé (Utilisateur connecté)
 */
router.post('/', authMiddleware, async (req, res) => {
  const { id: userId } = req.user;

  const { id_page, x, y, w, h } = req.body;

  if (id_page === undefined || x === undefined || y === undefined || w === undefined || h === undefined) {
    return res.status(400).json({ error: 'Données manquantes. Les champs id_page, x, y, w, h sont requis.' });
  }

  try {
    // Appel (simulé) au microservice IA
    const aiResult = await callAiMicroservice(id_page, { x, y, w, h });

    const { data, error } = await supabase
      .from('bulles')
      .insert([
        {
          id_page: id_page,
          id_user_createur: userId,
          x, y, w, h,
          texte_ocr_brut: aiResult.texteOcrBrut,
          texte_propose: aiResult.textePropose,
          statut: 'Proposé'
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);

  } catch (error) {
    console.error("Erreur lors de la création de la bulle:", error.message);
    res.status(500).json({ error: "Une erreur est survenue sur le serveur." });
  }
});

module.exports = router;