const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// La simulation d'IA est maintenant ici
const callAiMicroservice = async (pageId, coords) => {
  console.log(`(SIMULATION ÉCHEC) Appel au microservice IA pour la page ${pageId}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  return {
    texteOcrBrut: "",
    textePropose: "<REJET>"
  };
};

/**
 * @route   POST /api/analyse/bubble
 * @desc    Analyse une zone d'image et renvoie un texte proposé (sans sauvegarder)
 * @access  Privé
 */
router.post('/bubble', authMiddleware, async (req, res) => {
    const { id_page, x, y, w, h } = req.body;
    
    if (id_page === undefined || x === undefined || y === undefined || w === undefined || h === undefined) {
        return res.status(400).json({ error: 'Données manquantes.' });
    }

    try {
        const aiResult = await callAiMicroservice(id_page, { x, y, w, h });
        res.status(200).json(aiResult);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de l'analyse." });
    }
});

module.exports = router;