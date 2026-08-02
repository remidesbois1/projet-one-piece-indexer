const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createMangaRouter } = require('../src/routes/mangaRoutes');

async function withServer(router, callback) {
  const app = express();
  app.use('/api/mangas', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('manga cover thumbnails are generated server-side from the stored cover', async () => {
  const calls = [];
  const supabaseClient = {
    from(table) {
      calls.push(table);
      const query = {
        select() { return query; },
        eq() { return query; },
        single() { return Promise.resolve({ data: { cover_url: 'r2://public/covers/one-piece.jpg' }, error: null }); },
      };
      return query;
    },
  };

  const router = createMangaRouter({
    supabaseClient,
    readImage: async (reference) => {
      assert.equal(reference, 'r2://public/covers/one-piece.jpg');
      return { buffer: Buffer.from('cover') };
    },
    thumbnailImage: async (_buffer, options) => {
      assert.equal(options.width, 600);
      return Buffer.from('cover-thumbnail');
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mangas/one-piece/cover/thumbnail?width=600`);
    assert.equal(await response.text(), 'cover-thumbnail');
    assert.equal(response.headers.get('content-type'), 'image/avif');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });

  assert.deepEqual(calls, ['mangas']);
});
