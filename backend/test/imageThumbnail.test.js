const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');
const {
  createImageThumbnail,
  getThumbnailWidth,
} = require('../src/utils/imageThumbnail');

test('thumbnail widths are bounded to safe server-side limits', () => {
  assert.equal(getThumbnailWidth('640'), 640);
  assert.equal(getThumbnailWidth('4'), 96);
  assert.equal(getThumbnailWidth('99999'), 1600);
  assert.equal(getThumbnailWidth('invalid'), 640);
});

test('thumbnails use high-quality server-side resizing without enlargement', async () => {
  const source = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  }).png().toBuffer();

  const thumbnail = await createImageThumbnail(source, { width: 640 });
  const metadata = await sharp(thumbnail).metadata();

  assert.ok(['avif', 'heif'].includes(metadata.format));
  assert.equal(metadata.width, 640);
  assert.equal(metadata.height, 480);
});
