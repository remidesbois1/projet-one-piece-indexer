const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { authMiddleware, roleCheck } = require('../middleware/auth');
const sharp = require('sharp');
const axios = require('axios');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.post('/', authMiddleware, async (req, res) => {
  const { id: userId } = req.user;
  const { id_page, x, y, w, h, texte_propose } = req.body;

  if (id_page === undefined || x === undefined || y === undefined || w === undefined || h === undefined || texte_propose === undefined) {
    return res.status(400).json({ error: 'Données manquantes.' });
  }

  try {
    const { data: maxOrderData, error: maxOrderError } = await supabaseAdmin
      .from('bulles')
      .select('order')
      .eq('id_page', id_page)
      .order('order', { ascending: false })
      .limit(1)
      .single();

    const maxOrder = maxOrderData ? maxOrderData.order : 0;
    const newOrder = maxOrder + 1;

    const { data, error: insertError } = await supabaseAdmin
      .from('bulles')
      .insert([{
        id_page,
        id_user_createur: userId,
        x, y, w, h,
        texte_propose,
        statut: 'Proposé',
        order: newOrder
      }])
      .select()
      .single();

    if (insertError) throw insertError;
    const { error: pageUpdateError } = await supabaseAdmin
      .from('pages')
      .update({ statut: 'in_progress' })
      .eq('id', id_page);

    if (pageUpdateError) {
      console.error("Erreur lors de la mise à jour du statut de la page :", pageUpdateError);
    }

    res.status(201).json(data);

  } catch (error) {
    console.error("Erreur lors de la création de la bulle:", error);
    res.status(500).json({ error: "Erreur lors de la création de la bulle." });
  }
});

router.get('/pending', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
  const { page = 1, limit = 5 } = req.query;
  const pageInt = parseInt(page);
  const limitInt = parseInt(limit);
  const offset = (pageInt - 1) * limitInt;

  try {
    const { data, error } = await supabaseAdmin.rpc('get_pending_bubbles', {
      page_limit: limitInt,
      page_offset: offset
    });

    if (error) throw error;

    const results = data.map(bubble => ({
      ...bubble,
      crop_url: `/api/bulles/${bubble.id}/crop`
    }));

    res.status(200).json({
      results: results,
      totalCount: data.length > 0 ? data[0].total_count : 0
    });
  } catch (error) {
    console.error("Erreur backend sur /pending:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des bulles en attente." });
  }
});

router.put('/reorder', authMiddleware, async (req, res) => {
  const { orderedBubbles } = req.body;
  if (!orderedBubbles || !Array.isArray(orderedBubbles)) {
    return res.status(400).json({ error: "Un tableau de bulles ordonnées est requis." });
  }
  try {
    const { error } = await supabaseAdmin.rpc('reorder_bubbles', { bubbles_data: orderedBubbles });
    if (error) throw error;
    res.status(200).json({ message: "Ordre mis à jour." });
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de la mise à jour de l'ordre." });
  }
});

router.put('/validate-all', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('bulles')
      .update({ statut: 'Validé', validated_at: new Date() })
      .eq('statut', 'Proposé');

    if (error) throw error;

    res.status(200).json({ message: "Toutes les bulles en attente ont été validées avec succès." });
  } catch (error) {
    console.error("Erreur lors de la validation globale :", error);
    res.status(500).json({ error: "Erreur lors de la validation de toutes les bulles." });
  }
});

router.put('/:id/validate', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabaseAdmin.from('bulles').update({ statut: 'Validé', validated_at: new Date() }).eq('id', id).select();
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de la validation de la bulle." });
  }
});

router.put('/:id/reject', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabaseAdmin.from('bulles').update({ statut: 'Rejeté' }).eq('id', id).select();
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Erreur lors du rejet de la bulle." });
  }
});

router.get('/:id/crop', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: bubble, error } = await supabaseAdmin.from('bulles').select(`x, y, w, h, pages ( url_image )`).eq('id', id).single();
    if (error) throw error;
    if (!bubble || !bubble.pages?.url_image) {
      return res.status(404).json({ error: "Bulle ou image de la page non trouvée." });
    }
    const imageUrl = bubble.pages.url_image;

    const parsedUrl = new URL(imageUrl);
    const allowedHosts = [];
    if (process.env.SUPABASE_URL) allowedHosts.push(new URL(process.env.SUPABASE_URL).hostname);
    if (process.env.R2_PUBLIC_URL) {
      try { allowedHosts.push(new URL(process.env.R2_PUBLIC_URL).hostname); } catch (e) { }
    }

    if (!allowedHosts.some(host => parsedUrl.hostname.endsWith(host))) {
      throw new Error("Sécurité : Tentative de téléchargement hors du domaine autorisé (SSRF protection).");
    }

    const imageResponse = await axios({ url: imageUrl, responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data, 'binary');
    const croppedImageBuffer = await sharp(imageBuffer)
      .extract({ left: bubble.x, top: bubble.y, width: bubble.w, height: bubble.h })
      .avif({ quality: 20, effort: 2 })
      .toBuffer();
    res.set('Content-Type', 'image/avif');
    res.send(croppedImageBuffer);
  } catch (error) {
    res.status(500).json({ error: "Une erreur est survenue lors du traitement de l'image." });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { texte_propose } = req.body;
  const userId = req.user.id;
  const userRole = req.user.role;

  if (!texte_propose) {
    return res.status(400).json({ error: "Le champ 'texte_propose' est manquant." });
  }

  try {
    const { data: existingBubble, error: findError } = await supabaseAdmin
      .from('bulles')
      .select('id, id_user_createur')
      .eq('id', id)
      .single();

    if (findError || !existingBubble) {
      return res.status(404).json({ error: "Bulle non trouvée." });
    }

    const isCreator = existingBubble.id_user_createur === userId;
    const isStaff = ['Admin', 'Modo'].includes(userRole);

    if (!isCreator && !isStaff) {
      return res.status(403).json({ error: "Accès refusé. Vous n'avez pas les droits pour modifier cette bulle." });
    }
    const { data, error } = await supabaseAdmin
      .from('bulles')
      .update({ texte_propose: texte_propose })
      .eq('id', id)
      .select();

    if (error) throw error;

    res.status(200).json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lors de la mise à jour de la bulle." });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const { data: existingBubble, error: findError } = await supabaseAdmin.from('bulles').select('id, id_user_createur, statut').eq('id', id).single();
    if (findError || !existingBubble) {
      return res.status(404).json({ error: "Bulle non trouvée." });
    }
    if (existingBubble.id_user_createur !== userId) {
      return res.status(403).json({ error: "Accès refusé. Vous n'êtes pas le créateur de cette bulle." });
    }
    if (existingBubble.statut !== 'Proposé') {
      return res.status(403).json({ error: "Action refusée. La bulle a déjà été traitée par un modérateur." });
    }
    const { error } = await supabaseAdmin.from('bulles').delete().eq('id', id);
    if (error) throw error;
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de la suppression de la bulle." });
  }
});

module.exports = router;