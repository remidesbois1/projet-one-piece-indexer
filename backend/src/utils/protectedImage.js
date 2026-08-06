const sharp = require('sharp');

const BLUR_SIGMA = 13;
const REVEAL_PADDING_RATIO = 0.005;
const MIN_REVEAL_PADDING = 6;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getBubbleRevealBoxes(bubbles, imageWidth, imageHeight) {
  if (!imageWidth || !imageHeight) return [];

  const padding = Math.max(
    MIN_REVEAL_PADDING,
    Math.round(Math.min(imageWidth, imageHeight) * REVEAL_PADDING_RATIO)
  );

  return (bubbles || [])
    .map((bubble) => {
      const x = toFiniteNumber(bubble.x);
      const y = toFiniteNumber(bubble.y);
      const w = toFiniteNumber(bubble.w);
      const h = toFiniteNumber(bubble.h);

      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
        return null;
      }

      const left = clamp(Math.floor(x - padding), 0, imageWidth - 1);
      const top = clamp(Math.floor(y - padding), 0, imageHeight - 1);
      const right = clamp(Math.ceil(x + w + padding), left + 1, imageWidth);
      const bottom = clamp(Math.ceil(y + h + padding), top + 1, imageHeight);

      return {
        left,
        top,
        width: right - left,
        height: bottom - top
      };
    })
    .filter(Boolean);
}

async function createPublicPreviewImage(imageBuffer, bubbles) {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const imageWidth = metadata.width;
  const imageHeight = metadata.height;

  if (!imageWidth || !imageHeight) {
    throw new Error('Image dimensions are required to protect public preview');
  }

  const revealBoxes = getBubbleRevealBoxes(bubbles, imageWidth, imageHeight);
  const revealComposites = await Promise.all(
    revealBoxes.map(async (box) => ({
      input: await sharp(imageBuffer).extract(box).toBuffer(),
      left: box.left,
      top: box.top
    }))
  );

  return sharp(imageBuffer)
    .blur(BLUR_SIGMA)
    .composite(revealComposites)
    .avif({
      quality: 45,
      effort: 1,
      chromaSubsampling: '4:2:0'
    })
    .toBuffer();
}

module.exports = {
  createPublicPreviewImage,
  getBubbleRevealBoxes
};
