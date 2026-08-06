const sharp = require('sharp');

const DEFAULT_THUMBNAIL_WIDTH = 640;
const MIN_THUMBNAIL_WIDTH = 96;
const MAX_THUMBNAIL_WIDTH = 1600;

function getThumbnailWidth(value, fallback = DEFAULT_THUMBNAIL_WIDTH) {
  const parsed = Number.parseInt(value, 10);
  const width = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(width, MIN_THUMBNAIL_WIDTH), MAX_THUMBNAIL_WIDTH);
}

async function createImageThumbnail(imageBuffer, { width = DEFAULT_THUMBNAIL_WIDTH, quality = 72 } = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('An image buffer is required to create a thumbnail');
  }

  return sharp(imageBuffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: getThumbnailWidth(width),
      fit: 'inside',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    })
    .avif({
      quality,
      effort: 1,
      chromaSubsampling: '4:4:4',
    })
    .toBuffer();
}

module.exports = {
  DEFAULT_THUMBNAIL_WIDTH,
  MIN_THUMBNAIL_WIDTH,
  MAX_THUMBNAIL_WIDTH,
  getThumbnailWidth,
  createImageThumbnail,
};
