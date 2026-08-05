const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabaseClient');
const { authMiddleware, roleCheck } = require('../middleware/auth');
const { logBubbleHistory } = require('../utils/auditLogger');
const { readPageImage } = require('../utils/pageStorage');
const { BubbleCropError, createBubbleCrop } = require('../utils/bubbleCrop');
const { validateBubbleGeometryForPage } = require('../utils/bubbleGeometry');
const { mapBubbleReorderError } = require('../utils/bubbleReorder');
const { mapBubbleMutationError } = require('../utils/bubblePermissions');
const {
  bubbleCreateSchema,
  bubbleUpdateSchema,
  chapterIdParamsSchema,
  idParamsSchema,
  moderationCommentSchema,
  pageIdParamsSchema,
  pendingBubblesQuerySchema,
  reorderBubblesSchema,
  validateRequest,
} = require('../validation/requestSchemas');

router.post('/', authMiddleware, validateRequest({ body: bubbleCreateSchema }), async (req, res) => {
  const { id: userId } = req.user;
  const { id_page, x, y, w, h, texte_propose, order: explicitOrder } = req.validated.body;

  try {
    await validateBubbleGeometryForPage(id_page, { x, y, w, h });
    const { data: mutation, error } = await supabaseAdmin.rpc('create_editable_bubble', {
      p_actor_id: userId,
      p_page_id: id_page,
      p_x: x,
      p_y: y,
      p_w: w,
      p_h: h,
      p_text: texte_propose,
      p_order: explicitOrder ?? null,
    });
    if (error) throw error;
    const data = mutation?.after;
    if (!data) throw new Error('La création de la bulle n’a retourné aucune donnée.');

    // Audit Log: Creation
    await logBubbleHistory(data.id, userId, 'create', null, { ...data }, 'Création initiale');

    res.status(201).json(data);

  } catch (error) {
    console.error("Erreur lors de la création de la bulle:", error);
    const response = error.statusCode
      ? { status: error.statusCode, message: error.message }
      : mapBubbleMutationError(error, "Erreur lors de la création de la bulle.");
    res.status(response.status).json({ error: response.message });
  }
});

router.get('/pending', authMiddleware, roleCheck(['Admin', 'Modo']), validateRequest({ query: pendingBubblesQuerySchema }), async (req, res) => {
  const { page: pageInt, limit: limitInt } = req.validated.query;
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

router.put('/reorder', authMiddleware, validateRequest({ body: reorderBubblesSchema }), async (req, res) => {
  const { pageId, orderedBubbles } = req.validated.body;
  try {
    const { error } = await supabaseAdmin.rpc('reorder_page_bubbles', {
      p_page_id: pageId,
      p_actor_id: req.user.id,
      p_bubbles: orderedBubbles,
    });
    if (error) {
      const response = mapBubbleReorderError(error);
      return res.status(response.status).json({ error: response.message });
    }
    res.status(200).json({ message: "Ordre mis à jour." });
  } catch (error) {
    const response = mapBubbleReorderError(error);
    res.status(response.status).json({ error: response.message });
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

router.put('/:id/validate', authMiddleware, roleCheck(['Admin', 'Modo']), validateRequest({ params: idParamsSchema }), async (req, res) => {
  const { id } = req.validated.params;
  try {
    const { data: mutation, error } = await supabaseAdmin.rpc('moderate_proposed_bubble', {
      p_actor_id: req.user.id,
      p_bubble_id: id,
      p_decision: 'validate',
      p_comment: null,
    });
    if (error) throw error;
    const data = mutation?.after;
    if (!data) throw new Error('La validation n’a retourné aucune donnée.');

    // Audit Log: Validate
    await logBubbleHistory(id, req.user.id, 'validate', mutation.before, data, 'Validation effectuée');

    res.status(200).json(data);
  } catch (error) {
    const response = mapBubbleMutationError(error, "Erreur lors de la validation de la bulle.");
    res.status(response.status).json({ error: response.message });
  }
});

router.put('/:id/reject', authMiddleware, roleCheck(['Admin', 'Modo']), validateRequest({ params: idParamsSchema, body: moderationCommentSchema }), async (req, res) => {
  const { id } = req.validated.params;
  const { comment } = req.validated.body;
  try {
    const { data: mutation, error } = await supabaseAdmin.rpc('moderate_proposed_bubble', {
      p_actor_id: req.user.id,
      p_bubble_id: id,
      p_decision: 'reject',
      p_comment: comment || null,
    });
    if (error) throw error;
    const data = mutation?.after;
    if (!data) throw new Error('Le rejet n’a retourné aucune donnée.');

    // Audit Log: Reject
    await logBubbleHistory(id, req.user.id, 'reject', mutation.before, data, comment || 'Rejet effectué');

    res.status(200).json(data);
  } catch (error) {
    const response = mapBubbleMutationError(error, "Erreur lors du rejet de la bulle.");
    res.status(response.status).json({ error: response.message });
  }
});

router.get('/:id/crop', authMiddleware, validateRequest({ params: idParamsSchema }), async (req, res) => {
  const { id } = req.validated.params;
  try {
    const { data: bubble, error } = await supabaseAdmin.from('bulles').select(`x, y, w, h, pages ( url_image )`).eq('id', id).single();
    if (error) throw error;
    if (!bubble || !bubble.pages?.url_image) {
      return res.status(404).json({ error: "Bulle ou image de la page non trouvée." });
    }
    const { buffer: imageBuffer } = await readPageImage(bubble.pages.url_image);
    const croppedImageBuffer = await createBubbleCrop(imageBuffer, bubble);
    res.set('Content-Type', 'image/avif');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.vary('Authorization');
    res.send(croppedImageBuffer);
  } catch (error) {
    console.error("ERREUR CROP:", error);
    if (error instanceof BubbleCropError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    if (error?.code === 'PAGE_IMAGE_TOO_LARGE' || error?.code === 'PAGE_IMAGE_TIMEOUT') {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: "Une erreur est survenue lors du traitement de l'image." });
  }
});

router.put('/:id', authMiddleware, validateRequest({ params: idParamsSchema, body: bubbleUpdateSchema }), async (req, res) => {
  const { id } = req.validated.params;
  const { x, y, w, h, texte_propose } = req.validated.body;
  const userId = req.user.id;

  try {
    const { data: existingBubble, error: findError } = await supabaseAdmin
      .from('bulles')
      .select('*')
      .eq('id', id)
      .single();

    if (findError || !existingBubble) {
      return res.status(404).json({ error: "Bulle non trouvée." });
    }

    const isGeometryUpdate = x !== undefined || y !== undefined || w !== undefined || h !== undefined;
    if (isGeometryUpdate) {
      await validateBubbleGeometryForPage(existingBubble.id_page, {
        x: x ?? existingBubble.x,
        y: y ?? existingBubble.y,
        w: w ?? existingBubble.w,
        h: h ?? existingBubble.h,
      });
    }

    const updateData = {};
    if (x !== undefined) updateData.x = x;
    if (y !== undefined) updateData.y = y;
    if (w !== undefined) updateData.w = w;
    if (h !== undefined) updateData.h = h;
    if (texte_propose !== undefined) updateData.texte_propose = texte_propose;

    const { data: mutation, error } = await supabaseAdmin.rpc('update_editable_bubble', {
      p_actor_id: userId,
      p_bubble_id: id,
      p_patch: updateData,
    });
    if (error) throw error;
    const data = mutation?.after;
    const before = mutation?.before;
    if (!data || !before) throw new Error('La modification n’a retourné aucune donnée.');

    const isTextUpdate = texte_propose !== undefined;

    if (isTextUpdate) {
      await logBubbleHistory(
        id,
        userId,
        'update_text',
        { texte_propose: before.texte_propose },
        { texte_propose: texte_propose },
        'Modification du texte'
      );
    }

    if (isGeometryUpdate) {
      await logBubbleHistory(
        id,
        userId,
        'update_geometry',
        { x: before.x, y: before.y, w: before.w, h: before.h },
        { x: data.x, y: data.y, w: data.w, h: data.h },
        'Modification de la géométrie'
      );
    }

    res.status(200).json(data);

  } catch (error) {
    console.error(error);
    const response = error.statusCode
      ? { status: error.statusCode, message: error.message }
      : mapBubbleMutationError(error, "Erreur lors de la mise à jour de la bulle.");
    res.status(response.status).json({ error: response.message });
  }
});

router.delete('/page/:pageId', authMiddleware, roleCheck(['Admin']), validateRequest({ params: pageIdParamsSchema }), async (req, res) => {
  const { pageId } = req.validated.params;

  try {
    const { count, error } = await supabaseAdmin
      .from('bulles')
      .delete({ count: 'exact' })
      .eq('id_page', pageId);

    if (error) throw error;

    const { error: pageUpdateError } = await supabaseAdmin
      .from('pages')
      .update({ statut: 'not_started', commentaire_moderation: null })
      .eq('id', pageId);

    if (pageUpdateError) throw pageUpdateError;

    res.status(200).json({ deleted: count || 0 });
  } catch (error) {
    console.error("Erreur suppression bulles page:", error);
    res.status(500).json({ error: "Erreur lors de la suppression des bulles de la page." });
  }
});

router.delete('/chapter/:chapterId', authMiddleware, roleCheck(['Admin']), validateRequest({ params: chapterIdParamsSchema }), async (req, res) => {
  const { chapterId } = req.validated.params;

  try {
    const { data: pages, error: pagesError } = await supabaseAdmin
      .from('pages')
      .select('id')
      .eq('id_chapitre', chapterId);

    if (pagesError) throw pagesError;

    const pageIds = (pages || []).map(page => page.id);
    if (pageIds.length === 0) {
      return res.status(200).json({ deleted: 0 });
    }

    const { count, error } = await supabaseAdmin
      .from('bulles')
      .delete({ count: 'exact' })
      .in('id_page', pageIds);

    if (error) throw error;

    const { error: pageUpdateError } = await supabaseAdmin
      .from('pages')
      .update({ statut: 'not_started', commentaire_moderation: null })
      .in('id', pageIds);

    if (pageUpdateError) throw pageUpdateError;

    res.status(200).json({ deleted: count || 0, pages: pageIds.length });
  } catch (error) {
    console.error("Erreur suppression bulles chapitre:", error);
    res.status(500).json({ error: "Erreur lors de la suppression des bulles du chapitre." });
  }
});

router.delete('/:id', authMiddleware, validateRequest({ params: idParamsSchema }), async (req, res) => {
  const { id } = req.validated.params;
  try {
    const { error } = await supabaseAdmin.rpc('delete_editable_bubble', {
      p_actor_id: req.user.id,
      p_bubble_id: id,
    });
    if (error) throw error;
    res.status(204).send();
  } catch (error) {
    const response = mapBubbleMutationError(error, "Erreur lors de la suppression de la bulle.");
    res.status(response.status).json({ error: response.message });
  }
});

router.get('/:id/history', authMiddleware, validateRequest({ params: idParamsSchema }), async (req, res) => {
  const { id } = req.validated.params;
  try {
    const { data, error } = await supabaseAdmin
      .from('bubble_history')
      .select('*')
      .eq('bubble_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error("Erreur historique:", error);
    res.status(500).json({ error: "Impossible de récupérer l'historique." });
  }
});

module.exports = router;
