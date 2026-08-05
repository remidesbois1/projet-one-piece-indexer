const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');

const {
  BubbleCropError,
  createBubbleCrop,
  validateCropGeometry,
} = require('../src/utils/bubbleCrop');

test('bubble crops are decoded and encoded within explicit Sharp limits', async () => {
  const input = await sharp({
    create: { width: 100, height: 80, channels: 3, background: '#abcdef' },
  }).png().toBuffer();

  const output = await createBubbleCrop(input, { x: 20, y: 10, w: 30, h: 40 });
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.width, 30);
  assert.equal(metadata.height, 40);
  assert.equal(metadata.format, 'heif');
  assert.equal(metadata.compression, 'av1');
});

test('the crop processor receives fail-fast pixel and sequential-read limits', async () => {
  let receivedOptions;
  let receivedCrop;
  let receivedAvifOptions;
  let destroyed = false;
  const pipeline = {
    async metadata() { return { width: 100, height: 80 }; },
    autoOrient() { return pipeline; },
    extract(crop) { receivedCrop = crop; return pipeline; },
    avif(options) { receivedAvifOptions = options; return pipeline; },
    async toBuffer() { return Buffer.from('crop'); },
    destroy() { destroyed = true; },
  };

  const result = await createBubbleCrop(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    { x: 1, y: 2, w: 3, h: 4 }, {
      imageProcessor(_buffer, options) {
        receivedOptions = options;
        return pipeline;
      },
      maxInputPixels: 10_000,
      maxCropPixels: 100,
    }
  );

  assert.deepEqual(result, Buffer.from('crop'));
  assert.deepEqual(receivedOptions, {
    failOn: 'error',
    limitInputPixels: 10_000,
    sequentialRead: true,
  });
  assert.deepEqual(receivedCrop, { left: 1, top: 2, width: 3, height: 4 });
  assert.deepEqual(receivedAvifOptions, { quality: 20, effort: 2 });
  assert.equal(destroyed, true);
});

test('crop geometry must be integral, positive and contained in the decoded page', () => {
  for (const geometry of [
    { x: -1, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 0, h: 1 },
    { x: 0.5, y: 0, w: 1, h: 1 },
    { x: 99, y: 0, w: 2, h: 1 },
    { x: 0, y: 79, w: 1, h: 2 },
    { x: Number.MAX_SAFE_INTEGER, y: 0, w: 2, h: 1 },
  ]) {
    assert.throws(
      () => validateCropGeometry(geometry, { width: 100, height: 80 }, { maxCropPixels: 1000 }),
      (error) => error instanceof BubbleCropError && error.code === 'INVALID_CROP_GEOMETRY'
    );
  }
});

test('crop and decoded-source pixel bombs fail before extraction', async () => {
  assert.throws(
    () => validateCropGeometry(
      { x: 0, y: 0, w: 6000, h: 5000 },
      { width: 10_000, height: 10_000 },
      { maxCropPixels: 25_000_000 }
    ),
    (error) => error.code === 'CROP_PIXEL_LIMIT' && error.statusCode === 413
  );

  let extracted = false;
  const pipeline = {
    async metadata() { return { width: 11, height: 10 }; },
    autoOrient() { return pipeline; },
    extract() { extracted = true; return pipeline; },
    avif() { return pipeline; },
    async toBuffer() { return Buffer.from('crop'); },
    destroy() {},
  };
  await assert.rejects(
    () => createBubbleCrop(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { x: 0, y: 0, w: 1, h: 1 }, {
        imageProcessor: () => pipeline,
        maxInputPixels: 100,
        maxCropPixels: 100,
      }
    ),
    (error) => error.code === 'CROP_INPUT_PIXEL_LIMIT' && error.statusCode === 413
  );
  assert.equal(extracted, false);
});

test('corrupt image buffers fail as bounded validation errors', async () => {
  await assert.rejects(
    () => createBubbleCrop(Buffer.from('<svg><script/></svg>'), { x: 0, y: 0, w: 1, h: 1 }),
    (error) => error instanceof BubbleCropError
      && error.code === 'INVALID_CROP_IMAGE'
      && error.statusCode === 422
  );
});

test('Sharp pixel-limit failures keep their bounded 413 response', async () => {
  const input = await sharp({
    create: { width: 11, height: 10, channels: 3, background: '#abcdef' },
  }).png().toBuffer();

  await assert.rejects(
    () => createBubbleCrop(input, { x: 0, y: 0, w: 1, h: 1 }, {
      maxInputPixels: 100,
      maxCropPixels: 100,
    }),
    (error) => error.code === 'CROP_INPUT_PIXEL_LIMIT' && error.statusCode === 413
  );
});

test('EXIF-oriented JPEG crops use the same displayed coordinate system as the browser', async () => {
  const input = await sharp({
    create: { width: 30, height: 20, channels: 3, background: '#abcdef' },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

  const output = await createBubbleCrop(input, { x: 0, y: 0, w: 20, h: 30 });
  const metadata = await sharp(output).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 20, height: 30 });
});

test('active SVG payloads are rejected before Sharp can resolve external resources', async () => {
  let processorCalled = false;
  const payload = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    + '<image href="http://169.254.169.254/latest/meta-data/"/></svg>'
  );
  await assert.rejects(
    () => createBubbleCrop(payload, { x: 0, y: 0, w: 1, h: 1 }, {
      imageProcessor() { processorCalled = true; },
    }),
    (error) => error.code === 'INVALID_CROP_IMAGE'
  );
  assert.equal(processorCalled, false);
});
