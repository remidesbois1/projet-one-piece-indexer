const sharp = require('sharp');
const { supabaseAdmin } = require('../config/supabaseClient');
const { readPageImage } = require('./pageStorage');

const PAGE_DIMENSIONS_CACHE_TTL_MS = 30 * 60 * 1_000;
const MAX_CACHED_PAGE_DIMENSIONS = 500;
const pageDimensionsCache = new Map();
const pendingPageDimensions = new Map();

class BubbleGeometryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BubbleGeometryError';
    this.statusCode = statusCode;
  }
}

function assertBubbleWithinImage(geometry, imageSize) {
  const { x, y, w, h } = geometry;
  const { width, height } = imageSize;

  if (![x, y, w, h, width, height].every(Number.isFinite)) {
    throw new BubbleGeometryError('La géométrie ou les dimensions de l’image sont invalides.');
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) {
    throw new BubbleGeometryError('Les coordonnées de la bulle doivent être des entiers.');
  }
  if (x < 0 || y < 0 || w < 1 || h < 1) {
    throw new BubbleGeometryError('La bulle doit avoir des coordonnées positives et une taille non nulle.');
  }
  if (x + w > width || y + h > height) {
    throw new BubbleGeometryError(`La bulle dépasse l’image (${width}×${height}).`);
  }
  return geometry;
}

async function validateBubbleGeometryForPage(pageId, geometry, {
  supabaseClient = supabaseAdmin,
  readImage = readPageImage,
  readMetadata = async (buffer) => sharp(buffer).metadata(),
} = {}) {
  const { data: page, error } = await supabaseClient
    .from('pages')
    .select('url_image')
    .eq('id', pageId)
    .single();

  if (error || !page?.url_image) {
    throw new BubbleGeometryError('Page introuvable.', 404);
  }

  const cacheKey = `${pageId}:${page.url_image}`;
  const cached = pageDimensionsCache.get(cacheKey);
  let metadata;
  if (cached && cached.expiresAt > Date.now()) {
    metadata = cached;
  } else {
    if (cached) pageDimensionsCache.delete(cacheKey);
    let request = pendingPageDimensions.get(cacheKey);
    if (!request) {
      request = (async () => {
        const { buffer } = await readImage(page.url_image);
        const nextMetadata = await readMetadata(buffer);
        if (nextMetadata?.width && nextMetadata?.height) {
          pageDimensionsCache.set(cacheKey, {
            width: nextMetadata.width,
            height: nextMetadata.height,
            expiresAt: Date.now() + PAGE_DIMENSIONS_CACHE_TTL_MS,
          });
          while (pageDimensionsCache.size > MAX_CACHED_PAGE_DIMENSIONS) {
            pageDimensionsCache.delete(pageDimensionsCache.keys().next().value);
          }
        }
        return nextMetadata;
      })().finally(() => pendingPageDimensions.delete(cacheKey));
      pendingPageDimensions.set(cacheKey, request);
    }
    metadata = await request;
  }
  if (!metadata?.width || !metadata?.height) {
    throw new BubbleGeometryError('Impossible de déterminer les dimensions de l’image.', 422);
  }

  return assertBubbleWithinImage(geometry, {
    width: metadata.width,
    height: metadata.height,
  });
}

function clearBubbleGeometryCache() {
  pageDimensionsCache.clear();
  pendingPageDimensions.clear();
}

module.exports = {
  BubbleGeometryError,
  assertBubbleWithinImage,
  clearBubbleGeometryCache,
  validateBubbleGeometryForPage,
};
