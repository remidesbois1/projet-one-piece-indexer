const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  UnsupportedPageImageError,
  detectPageImageContentType,
  requirePageImageContentType,
  sniffPageImageBody,
} = require('../src/utils/pageImageMime');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'binary');
const AVIF = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypmif1', 'ascii'),
  Buffer.alloc(4),
  Buffer.from('avif', 'ascii'),
  Buffer.from('payload', 'ascii'),
]);

async function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('page image signatures identify each supported raster format', () => {
  assert.equal(detectPageImageContentType(JPEG), 'image/jpeg');
  assert.equal(detectPageImageContentType(PNG), 'image/png');
  assert.equal(detectPageImageContentType(WEBP), 'image/webp');
  assert.equal(detectPageImageContentType(AVIF), 'image/avif');

  const avifSequence = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x10]),
    Buffer.from('ftypavis', 'ascii'),
    Buffer.alloc(4),
  ]);
  assert.equal(detectPageImageContentType(avifSequence), 'image/avif');
});

test('lookalike and active-content payloads are not accepted as page images', () => {
  assert.equal(detectPageImageContentType(Buffer.from('RIFF1234NOPE')), null);
  assert.equal(detectPageImageContentType(Buffer.from('\x00\x00\x00\x14ftypisom\x00\x00\x00\x00mp42', 'binary')), null);
  assert.equal(detectPageImageContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.throws(() => requirePageImageContentType(Buffer.from('<html>')), UnsupportedPageImageError);
});

test('signature sniffing replays every byte when the signature spans stream chunks', async () => {
  for (const [input, expectedType] of [
    [JPEG, 'image/jpeg'],
    [PNG, 'image/png'],
    [WEBP, 'image/webp'],
    [AVIF, 'image/avif'],
  ]) {
    const oneByteChunks = [...input].map((byte) => Buffer.from([byte]));
    const sniffed = await sniffPageImageBody(Readable.from(oneByteChunks));

    assert.equal(sniffed.contentType, expectedType);
    assert.deepEqual(await bodyToBuffer(sniffed.body), input);
  }
});

test('buffer and AWS byte-array bodies retain their complete content', async () => {
  const bufferBody = Buffer.concat([PNG, Buffer.from('rest')]);
  const buffered = await sniffPageImageBody(bufferBody);
  assert.equal(buffered.body, bufferBody);
  assert.equal(buffered.contentType, 'image/png');

  const awsBody = {
    transformToByteArray: async () => Uint8Array.from(bufferBody),
  };
  const transformed = await sniffPageImageBody(awsBody);
  assert.equal(transformed.contentType, 'image/png');
  assert.deepEqual(await bodyToBuffer(transformed.body), bufferBody);
});

test('unsupported streamed content is rejected and the upstream body is closed', async () => {
  const source = Readable.from([
    Buffer.from('<html><body>not an image</body></html>'),
  ]);

  await assert.rejects(
    () => sniffPageImageBody(source),
    (error) => error instanceof UnsupportedPageImageError && error.statusCode === 415
  );
  assert.equal(source.destroyed, true);
});

test('signature sniffing rejects unsafe inspection bounds', async () => {
  await assert.rejects(
    () => sniffPageImageBody(PNG, { maxSignatureBytes: 12 }),
    /between 24 and 4096/
  );
  await assert.rejects(
    () => sniffPageImageBody(PNG, { maxSignatureBytes: 4097 }),
    /between 24 and 4096/
  );
});
