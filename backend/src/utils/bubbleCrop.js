const sharp = require('sharp');

const inputLimits = require('@poneglyph/shared/input-limits.json');
const { getOrientedImageDimensions } = require('./pageImageDimensions');
const { requirePageImageContentType } = require('./pageImageMime');

class BubbleCropError extends Error {
  constructor(code, message, { statusCode = 422 } = {}) {
    super(message);
    this.name = 'BubbleCropError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function validateCropGeometry(geometry, metadata, { maxCropPixels }) {
  const dimensions = getOrientedImageDimensions(metadata);
  if (!dimensions) {
    throw new BubbleCropError('INVALID_CROP_IMAGE', 'Les dimensions de l’image source sont invalides.');
  }
  const { width, height } = dimensions;

  const crop = {
    left: Number(geometry?.x),
    top: Number(geometry?.y),
    width: Number(geometry?.w),
    height: Number(geometry?.h),
  };
  if (
    !Number.isSafeInteger(crop.left)
    || !Number.isSafeInteger(crop.top)
    || !Number.isSafeInteger(crop.width)
    || !Number.isSafeInteger(crop.height)
    || crop.left < 0
    || crop.top < 0
    || crop.width < 1
    || crop.height < 1
    || crop.left > width - crop.width
    || crop.top > height - crop.height
  ) {
    throw new BubbleCropError('INVALID_CROP_GEOMETRY', 'La zone de crop sort des limites de la page.');
  }

  const cropPixels = crop.width * crop.height;
  if (!Number.isSafeInteger(cropPixels) || cropPixels > maxCropPixels) {
    throw new BubbleCropError(
      'CROP_PIXEL_LIMIT',
      'La zone de crop depasse la limite de pixels autorisee.',
      { statusCode: 413 }
    );
  }
  return crop;
}

async function createBubbleCrop(imageBuffer, geometry, {
  imageProcessor = sharp,
  maxInputPixels = inputLimits.chapterImagePixels,
  maxCropPixels = inputLimits.bubbleCropPixels,
} = {}) {
  assertPositiveLimit(maxInputPixels, 'maxInputPixels');
  assertPositiveLimit(maxCropPixels, 'maxCropPixels');
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new BubbleCropError('INVALID_CROP_IMAGE', 'L’image source est vide.');
  }

  let image;
  try {
    requirePageImageContentType(imageBuffer);
    image = imageProcessor(imageBuffer, {
      failOn: 'error',
      limitInputPixels: maxInputPixels,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const sourcePixels = Number(metadata?.width) * Number(metadata?.height);
    if (!Number.isSafeInteger(sourcePixels) || sourcePixels < 1 || sourcePixels > maxInputPixels) {
      throw new BubbleCropError('CROP_INPUT_PIXEL_LIMIT', 'L’image source depasse la limite de pixels.', {
        statusCode: 413,
      });
    }
    const crop = validateCropGeometry(geometry, metadata, { maxCropPixels });
    return await image
      .autoOrient()
      .extract(crop)
      .avif({ quality: 20, effort: 2 })
      .toBuffer();
  } catch (error) {
    if (error instanceof BubbleCropError) throw error;
    if (/exceeds pixel limit/i.test(String(error?.message || ''))) {
      throw new BubbleCropError('CROP_INPUT_PIXEL_LIMIT', 'L’image source dépasse la limite de pixels.', {
        statusCode: 413,
      });
    }
    throw new BubbleCropError('INVALID_CROP_IMAGE', 'L’image source ne peut pas etre decodee.');
  } finally {
    image?.destroy?.();
  }
}

module.exports = {
  BubbleCropError,
  createBubbleCrop,
  validateCropGeometry,
};
