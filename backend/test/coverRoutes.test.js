const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createCoverReference, createCoverRouter } = require('../src/routes/coverRoutes');

async function withServer(router, callback) {
  const app = express();
  app.use('/api/covers', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('cover thumbnails only read paths below the configured covers prefix', async () => {
  assert.equal(
    createCoverReference('covers/tome-22.jpg', 'https://media.example.test'),
    'https://media.example.test/covers/tome-22.jpg'
  );
  assert.throws(
    () => createCoverReference('../private/page.jpg', 'https://media.example.test'),
    /Invalid cover path/
  );

  const router = createCoverRouter({
    publicUrlBase: 'https://media.example.test',
    readImage: async (reference) => {
      assert.equal(reference, 'https://media.example.test/covers/tome-22.jpg');
      return { buffer: Buffer.from('cover') };
    },
    thumbnailImage: async (_buffer, options) => {
      assert.equal(options.width, 360);
      return Buffer.from('cover-thumbnail');
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/covers/thumbnail?path=tome-22.jpg&width=360`);
    assert.equal(await response.text(), 'cover-thumbnail');
    assert.equal(response.headers.get('content-type'), 'image/avif');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });
});
