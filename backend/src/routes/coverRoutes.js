const express = require('express');
const { readPageImage } = require('../utils/pageStorage');
const { createImageThumbnail, getThumbnailWidth } = require('../utils/imageThumbnail');

function createCoverReference(path, publicUrlBase = process.env.R2_PUBLIC_URL) {
    const requestedPath = String(path || '').replace(/^\/+/, '');
    const coverPath = requestedPath.startsWith('covers/') ? requestedPath : `covers/${requestedPath}`;

    if (!publicUrlBase || !coverPath || coverPath.includes('..') || coverPath.includes('\\')) {
        throw new Error('Invalid cover path');
    }

    const encodedPath = coverPath.split('/').map(encodeURIComponent).join('/');
    return `${publicUrlBase.replace(/\/$/, '')}/${encodedPath}`;
}

function createCoverRouter({
    readImage = readPageImage,
    thumbnailImage = createImageThumbnail,
    publicUrlBase = process.env.R2_PUBLIC_URL,
} = {}) {
    const router = express.Router();

    router.get('/thumbnail', async (req, res) => {
        try {
            const reference = createCoverReference(req.query.path, publicUrlBase);
            const { buffer: imageBuffer } = await readImage(reference);
            const thumbnailBuffer = await thumbnailImage(imageBuffer, {
                width: getThumbnailWidth(req.query.width, 512),
            });

            res.set('Content-Type', 'image/avif');
            res.set('Cache-Control', 'public, max-age=86400');
            res.set('Cross-Origin-Resource-Policy', 'cross-origin');
            res.send(thumbnailBuffer);
        } catch (error) {
            console.error("Erreur thumbnail couverture:", error);
            res.status(404).json({ error: "Couverture non trouvée" });
        }
    });

    return router;
}

const router = createCoverRouter();

module.exports = router;
module.exports.createCoverReference = createCoverReference;
module.exports.createCoverRouter = createCoverRouter;
