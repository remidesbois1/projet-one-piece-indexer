const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');

const {
  BubbleGeometryError,
  assertBubbleWithinImage,
  clearBubbleGeometryCache,
  readSafePageMetadata,
  validateBubbleGeometryForPage,
} = require('../src/utils/bubbleGeometry');

test('bubble geometry accepts exact image edges and rejects invalid rectangles', () => {
  assert.deepEqual(
    assertBubbleWithinImage({ x: 0, y: 0, w: 100, h: 200 }, { width: 100, height: 200 }),
    { x: 0, y: 0, w: 100, h: 200 }
  );

  for (const geometry of [
    { x: -1, y: 0, w: 10, h: 10 },
    { x: 0, y: 0, w: 0, h: 10 },
    { x: 90, y: 0, w: 11, h: 10 },
    { x: 0, y: 191, w: 10, h: 10 },
    { x: 0.5, y: 0, w: 10, h: 10 },
  ]) {
    assert.throws(
      () => assertBubbleWithinImage(geometry, { width: 100, height: 200 }),
      BubbleGeometryError
    );
  }
});

function pageClient(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    single() { return Promise.resolve(result); },
  };
  return { from(table) { assert.equal(table, 'pages'); return query; } };
}

test('page-aware geometry validation checks the stored image dimensions', async () => {
  clearBubbleGeometryCache();
  let readReference;
  await validateBubbleGeometryForPage(42, { x: 10, y: 20, w: 30, h: 40 }, {
    supabaseClient: pageClient({ data: { url_image: 'r2://private/page.avif' }, error: null }),
    readImage: async (reference) => {
      readReference = reference;
      return { buffer: Buffer.from('image') };
    },
    readMetadata: async () => ({ width: 100, height: 100 }),
  });
  assert.equal(readReference, 'r2://private/page.avif');

  await assert.rejects(
    validateBubbleGeometryForPage(42, { x: 80, y: 20, w: 30, h: 40 }, {
      supabaseClient: pageClient({ data: { url_image: 'r2://private/page.avif' }, error: null }),
      readImage: async () => ({ buffer: Buffer.from('image') }),
      readMetadata: async () => ({ width: 100, height: 100 }),
    }),
    (error) => error instanceof BubbleGeometryError && error.statusCode === 400
  );
});

test('page-aware geometry validation distinguishes missing and unreadable images', async () => {
  clearBubbleGeometryCache();
  await assert.rejects(
    validateBubbleGeometryForPage(999, { x: 0, y: 0, w: 1, h: 1 }, {
      supabaseClient: pageClient({ data: null, error: { message: 'missing' } }),
    }),
    (error) => error instanceof BubbleGeometryError && error.statusCode === 404
  );

  await assert.rejects(
    validateBubbleGeometryForPage(42, { x: 0, y: 0, w: 1, h: 1 }, {
      supabaseClient: pageClient({ data: { url_image: 'r2://private/page.bin' }, error: null }),
      readImage: async () => ({ buffer: Buffer.from('not-an-image') }),
      readMetadata: async () => ({}),
    }),
    (error) => error instanceof BubbleGeometryError && error.statusCode === 422
  );
});

test('page dimensions are cached without masking a changed image reference', async () => {
  clearBubbleGeometryCache();
  let reads = 0;
  const client = pageClient({ data: { url_image: 'r2://private/page.avif' }, error: null });
  const options = {
    supabaseClient: client,
    readImage: async () => { reads += 1; return { buffer: Buffer.from('image') }; },
    readMetadata: async () => ({ width: 100, height: 100 }),
  };

  await validateBubbleGeometryForPage(42, { x: 0, y: 0, w: 10, h: 10 }, options);
  await validateBubbleGeometryForPage(42, { x: 10, y: 10, w: 10, h: 10 }, options);
  assert.equal(reads, 1);
});

test('concurrent geometry checks share the same metadata read', async () => {
  clearBubbleGeometryCache();
  let reads = 0;
  const options = {
    supabaseClient: pageClient({ data: { url_image: 'r2://private/concurrent.avif' }, error: null }),
    readImage: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { buffer: Buffer.from('image') };
    },
    readMetadata: async () => ({ width: 100, height: 100 }),
  };

  await Promise.all([
    validateBubbleGeometryForPage(7, { x: 0, y: 0, w: 10, h: 10 }, options),
    validateBubbleGeometryForPage(7, { x: 20, y: 20, w: 10, h: 10 }, options),
  ]);
  assert.equal(reads, 1);
});

test('page-aware geometry validates against EXIF-oriented display dimensions', async () => {
  clearBubbleGeometryCache();
  const input = await sharp({
    create: { width: 30, height: 20, channels: 3, background: '#abcdef' },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

  await validateBubbleGeometryForPage(43, { x: 0, y: 0, w: 20, h: 30 }, {
    supabaseClient: pageClient({ data: { url_image: 'r2://private/oriented.jpg' }, error: null }),
    readImage: async () => ({ buffer: input }),
  });
});

test('page metadata pixel bombs retain a bounded 413 response', async () => {
  const input = await sharp({
    create: { width: 11, height: 10, channels: 3, background: '#abcdef' },
  }).png().toBuffer();
  await assert.rejects(
    () => readSafePageMetadata(input, { maxPixels: 100 }),
    (error) => error instanceof BubbleGeometryError && error.statusCode === 413
  );
});
