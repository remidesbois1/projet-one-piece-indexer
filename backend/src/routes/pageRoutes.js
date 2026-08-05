const express = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { supabaseAdmin } = require('../config/supabaseClient');
const { authMiddleware, optionalAuthMiddleware, roleCheck } = require('../middleware/auth');
const { createPublicPreviewImage } = require('../utils/protectedImage');
const {
    VALIDATED_BUBBLE_STATUS,
    toPageDto,
    toPublicBubbleDto,
} = require('../utils/publicMedia');
const { openPageImage, readPageImage } = require('../utils/pageStorage');
const { createImageThumbnail, getThumbnailWidth } = require('../utils/imageThumbnail');
const { mapBubbleMutationError } = require('../utils/bubblePermissions');
const {
    UnsupportedPageImageError,
    requirePageImageContentType,
    sniffPageImageBody,
} = require('../utils/pageImageMime');

async function streamImageBody(body, response) {
    if (!body) throw new Error('R2 returned an empty page object');
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        response.end(body);
        return;
    }

    let readable = body;
    if (typeof body.pipe !== 'function') {
        if (typeof body.getReader === 'function') readable = Readable.fromWeb(body);
        else if (body[Symbol.asyncIterator]) readable = Readable.from(body);
        else if (typeof body.transformToByteArray === 'function') {
            response.end(Buffer.from(await body.transformToByteArray()));
            return;
        } else {
            throw new Error('R2 returned an unsupported page stream');
        }
    }

    await pipeline(readable, response);
}

function privateImageHeaders(_req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.vary('Authorization');
    next();
}

function isUnsupportedPageImageError(error) {
    return error instanceof UnsupportedPageImageError || error?.code === 'UNSUPPORTED_PAGE_IMAGE';
}

function sendPrivateImageError(res, error, fallbackMessage) {
    if (isUnsupportedPageImageError(error)) {
        return res.status(415).json({ error: error.message });
    }
    return res.status(500).json({ error: fallbackMessage });
}

function createPageRouter({
    supabaseClient = supabaseAdmin,
    supabaseAdminClient = supabaseAdmin,
    requireAuth = authMiddleware,
    optionalAuth = optionalAuthMiddleware,
    requireRole = roleCheck,
    openImage = openPageImage,
    readImage = readPageImage,
    previewImage = createPublicPreviewImage,
    thumbnailImage = createImageThumbnail,
} = {}) {
const router = express.Router();

router.get('/', optionalAuth, async (req, res) => {
    console.log('GET pages', req.query);
    const { id_chapitre } = req.query;
    if (!id_chapitre) return res.status(400).json({ error: "id_chapitre manquant" });

    const { data, error } = await supabaseClient
        .from('pages')
        .select('id, id_chapitre, numero_page, statut')
        .eq('id_chapitre', id_chapitre)
        .order('numero_page', { ascending: true });

    if (error) return res.status(500).json({ error: "Erreur serveur" });
    res.json((data || []).map((page) => toPageDto(page, { authenticated: Boolean(req.user) })));
});

router.get('/:id', optionalAuth, async (req, res) => {
    const { data, error } = await supabaseClient
        .from('pages')
        .select('id, id_chapitre, numero_page, statut, description, commentaire_moderation, chapitres(numero, tomes(numero))')
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(500).json({ error: "Erreur serveur" });
    if (!data) return res.status(404).json({ error: "Page non trouvée" });
    res.json(toPageDto(data, { authenticated: Boolean(req.user) }));
});

router.get('/:id/bulles', optionalAuth, async (req, res) => {
    let query = supabaseClient
        .from('bulles')
        .select('id, x, y, w, h, texte_propose, statut, id_user_createur, order')
        .eq('id_page', req.params.id);

    query = req.user
        ? query.neq('statut', 'Rejeté')
        : query.eq('statut', VALIDATED_BUBBLE_STATUS);

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: "Erreur fetch bulles" });
    res.json(req.user ? (data || []) : (data || []).map(toPublicBubbleDto));
});

router.put('/:id/submit-review', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabaseAdminClient.rpc('submit_page_for_review', {
            p_actor_id: req.user.id,
            p_page_id: req.params.id,
        });
        if (error) throw error;
        return res.json(data);
    } catch (error) {
        const response = mapBubbleMutationError(error, 'Erreur soumission');
        return res.status(response.status).json({ error: response.message });
    }
});

router.put('/:id/status', requireAuth, requireRole(['Admin']), async (req, res) => {
    const { statut } = req.body;
    const allowedStatuses = ['not_started', 'in_progress', 'pending_review', 'completed'];

    if (!allowedStatuses.includes(statut)) {
        return res.status(400).json({ error: "Statut invalide" });
    }

    const updatePayload = { statut };
    if (statut !== 'in_progress') updatePayload.commentaire_moderation = null;

    const { data, error } = await supabaseAdminClient
        .from('pages')
        .update(updatePayload)
        .eq('id', req.params.id)
        .select('*, chapitres(numero, tomes(numero))')
        .single();

    if (error) return res.status(500).json({ error: "Erreur mise à jour statut" });
    res.json(data);
});

router.get('/:id/image', async (req, res) => {
    const { id } = req.params;

    try {
        const { data: page, error } = await supabaseClient
            .from('pages')
            .select('url_image')
            .eq('id', id)
            .single();

        if (error || !page) return res.status(404).json({ error: "Page non trouvée" });

        const { buffer: imageBuffer } = await readImage(page.url_image);

        const { data: bubbles, error: bubblesError } = await supabaseClient
            .from('bulles')
            .select('x, y, w, h')
            .eq('id_page', id)
            .eq('statut', VALIDATED_BUBBLE_STATUS);

        if (bubblesError) throw bubblesError;

        const protectedImageBuffer = await previewImage(imageBuffer, bubbles);

        res.set('Content-Type', 'image/avif');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.send(protectedImageBuffer);

    } catch (err) {
        console.error("Erreur service image:", err);
        res.status(500).json({ error: "Erreur lors du traitement de l'image" });
    }
});

router.get('/:id/image/thumbnail', async (req, res) => {
    const { id } = req.params;

    try {
        const { data: page, error } = await supabaseClient
            .from('pages')
            .select('url_image')
            .eq('id', id)
            .single();

        if (error || !page) return res.status(404).json({ error: "Page non trouvÃ©e" });

        const { buffer: imageBuffer } = await readImage(page.url_image);
        const { data: bubbles, error: bubblesError } = await supabaseClient
            .from('bulles')
            .select('x, y, w, h')
            .eq('id_page', id)
            .eq('statut', VALIDATED_BUBBLE_STATUS);

        if (bubblesError) throw bubblesError;

        const protectedImageBuffer = await previewImage(imageBuffer, bubbles);
        const thumbnailBuffer = await thumbnailImage(protectedImageBuffer, {
            width: getThumbnailWidth(req.query.width),
        });

        res.set('Content-Type', 'image/avif');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.send(thumbnailBuffer);
    } catch (error) {
        console.error("Erreur thumbnail image:", error);
        res.status(500).json({ error: "Erreur lors du traitement de l'image" });
    }
});

router.get('/:id/image/original', privateImageHeaders, requireAuth, async (req, res) => {
    try {
        const { data: page, error } = await supabaseClient
            .from('pages')
            .select('url_image')
            .eq('id', req.params.id)
            .single();

        if (error || !page) return res.status(404).json({ error: "Page non trouvée" });

        const { body, contentLength } = await openImage(page.url_image);
        const inspectedImage = await sniffPageImageBody(body);
        res.set('Content-Type', inspectedImage.contentType);
        if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
            res.set('Content-Length', String(contentLength));
        }
        await streamImageBody(inspectedImage.body, res);
        return undefined;
    } catch (error) {
        if (res.headersSent) {
            res.destroy(error);
            return undefined;
        }
        if (!isUnsupportedPageImageError(error)) console.error("Erreur service image originale:", error);
        return sendPrivateImageError(res, error, "Erreur lors du chargement de l'image");
    }
});

router.get('/:id/image/original/thumbnail', privateImageHeaders, requireAuth, async (req, res) => {
    try {
        const { data: page, error } = await supabaseClient
            .from('pages')
            .select('url_image')
            .eq('id', req.params.id)
            .single();

        if (error || !page) return res.status(404).json({ error: "Page non trouvÃ©e" });

        const { buffer: imageBuffer } = await readImage(page.url_image);
        requirePageImageContentType(imageBuffer);
        const thumbnailBuffer = await thumbnailImage(imageBuffer, {
            width: getThumbnailWidth(req.query.width),
        });

        res.set('Content-Type', 'image/avif');
        res.send(thumbnailBuffer);
    } catch (error) {
        if (!isUnsupportedPageImageError(error)) console.error("Erreur thumbnail image originale:", error);
        sendPrivateImageError(res, error, "Erreur lors du traitement de l'image");
    }
});

return router;
}

const router = createPageRouter();

module.exports = router;
module.exports.createPageRouter = createPageRouter;
