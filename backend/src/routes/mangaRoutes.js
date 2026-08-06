const express = require('express');
const { supabase } = require('../config/supabaseClient');
const { readPageImage } = require('../utils/pageStorage');
const { createImageThumbnail, getThumbnailWidth } = require('../utils/imageThumbnail');
const { imageCache, cacheKey } = require('../utils/imageCache');

function createMangaRouter({
    supabaseClient = supabase,
    readImage = readPageImage,
    thumbnailImage = createImageThumbnail,
} = {}) {
const router = express.Router();

// Get all mangas
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseClient
            .from('mangas')
            .select('*')
            .eq('enabled', true)
            .order('titre', { ascending: true });

        if (error) throw error;

        res.json(data);
    } catch (error) {
        console.error("Erreur mangs:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

router.get('/:slug/cover/thumbnail', async (req, res) => {
    try {
        const { data: manga, error } = await supabaseClient
            .from('mangas')
            .select('cover_url')
            .eq('slug', req.params.slug)
            .eq('enabled', true)
            .single();

        if (error || !manga?.cover_url) {
            return res.status(404).json({ error: "Couverture non trouvée" });
        }

        const width = getThumbnailWidth(req.query.width, 600);
        const path = manga.cover_url;
        const key = cacheKey.cover({ path, width });
        
        let thumbnailBuffer;
        
        if (imageCache.has(key)) {
            thumbnailBuffer = imageCache.get(key);
        } else {
            const { buffer: imageBuffer } = await readImage(manga.cover_url);
            thumbnailBuffer = await thumbnailImage(imageBuffer, { width });
            imageCache.set(key, thumbnailBuffer);
        }

        res.set('Content-Type', 'image/avif');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.send(thumbnailBuffer);
    } catch (error) {
        console.error("Erreur thumbnail couverture manga:", error);
        res.status(500).json({ error: "Erreur lors du traitement de la couverture" });
    }
});

// Get manga by slug
router.get('/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { data, error } = await supabaseClient
            .from('mangas')
            .select('*')
            .eq('slug', slug)
            .eq('enabled', true)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Manga non trouvé" });

        res.json(data);
    } catch (error) {
        console.error("Erreur manga:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

return router;
}

const router = createMangaRouter();

module.exports = router;
module.exports.createMangaRouter = createMangaRouter;
