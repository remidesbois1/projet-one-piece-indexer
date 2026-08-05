const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const {
  isPageImageValidationError,
  preparePageUpload,
} = require('../src/services/pageUpload');

async function withTempDirectory(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'poneglyph-page-upload-'));
  try {
    await callback(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test('page uploads derive their MIME from image bytes rather than the filename', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'misleading-name.avif');
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#123456' },
    }).png().toBuffer();
    await fs.promises.writeFile(filePath, png);

    const upload = await preparePageUpload(filePath);

    assert.equal(upload.contentType, 'image/png');
    assert.equal(upload.metadata.format, 'png');
    assert.deepEqual(upload.buffer, png);
  });
});

test('page uploads accept genuine AVIF images reported as HEIF by Sharp', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'page.avif');
    const avif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#abcdef' },
    }).avif().toBuffer();
    await fs.promises.writeFile(filePath, avif);

    const upload = await preparePageUpload(filePath);

    assert.equal(upload.metadata.format, 'heif');
    assert.equal(upload.metadata.contentType, 'image/avif');
    assert.equal(upload.contentType, 'image/avif');
    assert.deepEqual(upload.buffer, avif);
  });
});

test('page uploads reject active content even when it has an image extension', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'payload.jpg');
    await fs.promises.writeFile(filePath, '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    await assert.rejects(
      () => preparePageUpload(filePath),
      (error) => isPageImageValidationError(error)
    );
  });
});

test('page uploads fail closed if inspection and final bytes disagree', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(
    () => preparePageUpload('unused', {
      inspect: async () => ({ format: 'jpeg', contentType: 'image/jpeg' }),
      readFile: async () => png,
    }),
    (error) => error.code === 'UNSUPPORTED_PAGE_IMAGE' && error.statusCode === 415
  );
});
