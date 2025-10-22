const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const { authMiddleware, roleCheck } = require('../middleware/auth');
const sharp = require('sharp');
const axios = require('axios');

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

/**
 * @route   GET /api/bulles/pending
 * @desc    Récupérer toutes les bulles en attente de validation
 * @access  Privé (Modo/Admin)
 */
router.get('/pending', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bulles')
      .select('id, texte_propose')
      .eq('statut', 'Proposé')
      .order('created_at', { ascending: true });

    if (error) throw error;
    
    // On ajoute dynamiquement l'URL pour le crop
    const results = data.map(bubble => ({
      ...bubble,
      crop_url: `/api/bulles/${bubble.id}/crop`
    }));

    res.status(200).json(results);
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de la récupération des bulles en attente."});
  }
});

/**
 * @route   PUT /api/bulles/:id/validate
 * @desc    Valider une bulle
 * @access  Privé (Modo/Admin)
 */
router.put('/:id/validate', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('bulles')
            .update({ statut: 'Validé', validated_at: new Date() })
            .eq('id', id)
            .select();
        
        if(error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la validation de la bulle."});
    }
});

/**
 * @route   PUT /api/bulles/:id/reject
 * @desc    Rejeter une bulle
 * @access  Privé (Modo/Admin)
 */
router.put('/:id/reject', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('bulles')
            .update({ statut: 'Rejeté' })
            .eq('id', id)
            .select();

        if(error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors du rejet de la bulle."});
    }
});

/**
 * @route   GET /api/bulles/:id/crop
 * @desc    Récupérer un "cut-out" de l'image d'une bulle
 * @access  Privé (Modo/Admin)
 */
router.get('/:id/crop', authMiddleware, async (req, res) => {
  // TODO: Ajouter la vérification de rôle (Modo/Admin)
  const { id } = req.params;

  try {
    const { data: bubble, error } = await supabase
      .from('bulles')
      .select(`
        x, y, w, h,
        pages ( url_image )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!bubble || !bubble.pages?.url_image) {
      return res.status(404).json({ error: "Bulle ou image de la page non trouvée." });
    }

    const imageUrl = bubble.pages.url_image;
    const imageResponse = await axios({ url: imageUrl, responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data, 'binary');

    const croppedImageBuffer = await sharp(imageBuffer)
      .extract({ 
        left: bubble.x, 
        top: bubble.y, 
        width: bubble.w, 
        height: bubble.h 
      })
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    res.send(croppedImageBuffer);

  } catch (error) {
    console.error(`Erreur lors du découpage de la bulle ${id}:`, error.message);
    res.status(500).json({ error: "Une erreur est survenue lors du traitement de l'image." });
  }
});

/**
 * @route   PUT /api/bulles/:id
 * @desc    Mettre à jour le texte d'une bulle proposée
 * @access  Privé (créateur de la bulle)
 */
router.put('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { texte_propose } = req.body;
    const userId = req.user.id;

    if (!texte_propose) {
        return res.status(400).json({ error: "Le champ 'texte_propose' est manquant." });
    }

    try {
        const { data: existingBubble, error: findError } = await supabase
            .from('bulles')
            .select('id, id_user_createur')
            .eq('id', id)
            .single();

        if (findError || !existingBubble) {
            return res.status(404).json({ error: "Bulle non trouvée." });
        }
        if (existingBubble.id_user_createur !== userId) {
            return res.status(403).json({ error: "Accès refusé. Vous n'êtes pas le créateur de cette bulle." });
        }

        const { data, error } = await supabase
            .from('bulles')
            .update({ texte_propose: texte_propose })
            .eq('id', id)
            .select();
        
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la mise à jour de la bulle." });
    }
});

/**
 * @route   DELETE /api/bulles/:id
 * @desc    Supprimer une de ses propres bulles en attente
 * @access  Privé (créateur de la bulle)
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        const { data: existingBubble, error: findError } = await supabase
            .from('bulles')
            .select('id, id_user_createur, statut')
            .eq('id', id)
            .single();

        if (findError || !existingBubble) {
            return res.status(404).json({ error: "Bulle non trouvée." });
        }
        if (existingBubble.id_user_createur !== userId) {
            return res.status(403).json({ error: "Accès refusé. Vous n'êtes pas le créateur de cette bulle." });
        }
        if (existingBubble.statut !== 'Proposé') {
            return res.status(403).json({ error: "Action refusée. La bulle a déjà été traitée par un modérateur." });
        }

        const { error } = await supabase.from('bulles').delete().eq('id', id);
        
        if (error) throw error;
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la suppression de la bulle." });
    }
});

module.exports = router;