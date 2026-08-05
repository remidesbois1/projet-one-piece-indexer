const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const express = require('express');

const { createPageRouter } = require('../src/routes/pageRoutes');
const {
  VALIDATED_BUBBLE_STATUS,
  getPageImagePath,
  keepValidatedBubbleRows,
  toPageDto,
} = require('../src/utils/publicMedia');

const RAW_PAGE_URL = 'https://s3.onepiece-index.com/tome-1/chapitre-1/page.avif';

function createQuery(resolveRows, calls, table) {
  const state = { table, select: null, filters: [] };
  calls.push(state);

  const query = {
    select(value) {
      state.select = value;
      return query;
    },
    eq(field, value) {
      state.filters.push({ operator: 'eq', field, value });
      return query;
    },
    neq(field, value) {
      state.filters.push({ operator: 'neq', field, value });
      return query;
    },
    in(field, value) {
      state.filters.push({ operator: 'in', field, value });
      return query;
    },
    order() {
      return query;
    },
    single() {
      return Promise.resolve(resolveRows(state, true));
    },
    then(resolve, reject) {
      return Promise.resolve(resolveRows(state, false)).then(resolve, reject);
    },
  };

  return query;
}

function createFakeSupabase() {
  const calls = [];
  const page = {
    id: 42,
    id_chapitre: 9,
    numero_page: 3,
    url_image: RAW_PAGE_URL,
    statut: 'in_progress',
    description: { content: 'secret draft' },
    commentaire_moderation: 'internal note',
    chapitres: { numero: 1, tomes: { numero: 1 } },
  };
  const bubbles = [
    { id: 1, id_page: '42', x: 10, y: 20, w: 30, h: 40, texte_propose: 'valid', statut: VALIDATED_BUBBLE_STATUS, id_user_createur: 'user-1', order: 1 },
    { id: 2, id_page: '42', x: 50, y: 60, w: 70, h: 80, texte_propose: 'draft', statut: 'Proposé', id_user_createur: 'user-2', order: 2 },
  ];

  function resolveRows(state, single) {
    if (state.table === 'pages') {
      const selectedPage = state.select?.includes('chapitres')
        ? page
        : {
            id: page.id,
            id_chapitre: page.id_chapitre,
            numero_page: page.numero_page,
            statut: page.statut,
            url_image: page.url_image,
          };
      return { data: single ? selectedPage : [selectedPage], error: null };
    }

    let rows = bubbles;
    for (const filter of state.filters) {
      if (filter.operator === 'eq') rows = rows.filter((row) => row[filter.field] === filter.value);
      if (filter.operator === 'neq') rows = rows.filter((row) => row[filter.field] !== filter.value);
      if (filter.operator === 'in') rows = rows.filter((row) => filter.value.includes(row[filter.field]));
    }
    return { data: single ? rows[0] : rows, error: null };
  }

  return {
    calls,
    client: {
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      from(table) {
        return createQuery(resolveRows, calls, table);
      },
    },
  };
}

async function withServer(router, callback) {
  const app = express();
  app.use((_req, res, next) => {
    res.vary('Origin');
    next();
  });
  app.use('/api/pages', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function assertNoRawStorageUrl(value) {
  assert.doesNotMatch(JSON.stringify(value), /(?:r2\.cloudflarestorage\.com|s3\.|amazonaws\.com)/i);
}

function assertPrivateImageHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('expires'), '0');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const vary = new Set((response.headers.get('vary') || '').split(',').map((value) => value.trim().toLowerCase()));
  assert.ok(vary.has('origin'));
  assert.ok(vary.has('authorization'));
}

test('page image paths are application-owned and page DTOs never serialize the stored URL', () => {
  assert.equal(getPageImagePath(42), '/api/pages/42/image');

  const dto = toPageDto({ id: 42, numero_page: 3, url_image: RAW_PAGE_URL });
  assert.deepEqual(dto, { id: 42, numero_page: 3, url_image: '/api/pages/42/image' });
  assertNoRawStorageUrl(dto);
});

test('public page endpoints hide raw media, workflow fields, creators, and draft bubbles', async () => {
  const fake = createFakeSupabase();
  const rawImage = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('raw-image'),
  ]);
  const router = createPageRouter({
    supabaseClient: fake.client,
    supabaseAdminClient: fake.client,
    optionalAuth: (_req, _res, next) => next(),
    requireAuth: (req, res, next) => req.headers.authorization === 'Bearer valid-token'
      ? next()
      : res.status(401).json({ error: 'unauthorized' }),
    requireRole: () => (_req, _res, next) => next(),
    openImage: async () => ({
      body: Readable.from([rawImage.subarray(0, 4), rawImage.subarray(4)]),
      contentType: 'image/avif',
      contentLength: rawImage.length,
    }),
    readImage: async () => ({ buffer: rawImage, contentType: 'image/avif' }),
    previewImage: async (_buffer, bubbles) => {
      assert.equal(bubbles.length, 1);
      return Buffer.from('protected-preview');
    },
    thumbnailImage: async (buffer, options) => {
      assert.ok(Buffer.isBuffer(buffer));
      assert.equal(options.width, 640);
      return Buffer.from('thumbnail');
    },
  });

  await withServer(router, async (baseUrl) => {
    const list = await (await fetch(`${baseUrl}/api/pages?id_chapitre=9`)).json();
    assert.deepEqual(list, [{ id: 42, numero_page: 3, url_image: '/api/pages/42/image' }]);
    assertNoRawStorageUrl(list);

    const detail = await (await fetch(`${baseUrl}/api/pages/42`)).json();
    assert.equal(detail.url_image, '/api/pages/42/image');
    assert.equal(detail.id_chapitre, undefined);
    assert.equal(detail.description, undefined);
    assert.equal(detail.commentaire_moderation, undefined);
    assertNoRawStorageUrl(detail);

    const publicBubbles = await (await fetch(`${baseUrl}/api/pages/42/bulles`)).json();
    assert.deepEqual(publicBubbles.map((bubble) => bubble.id), [1]);
    assert.equal(publicBubbles[0].id_user_createur, undefined);
    assert.equal(publicBubbles[0].statut, undefined);

    const preview = await fetch(`${baseUrl}/api/pages/42/image?token=leaked-access-token`);
    assert.equal(await preview.text(), 'protected-preview');
    assert.match(preview.headers.get('cache-control'), /^public,/);
    assert.equal(preview.headers.get('cross-origin-resource-policy'), 'cross-origin');

    const previewThumbnail = await fetch(`${baseUrl}/api/pages/42/image/thumbnail?width=640`);
    assert.equal(await previewThumbnail.text(), 'thumbnail');
    assert.equal(previewThumbnail.headers.get('content-type'), 'image/avif');
    assert.equal(previewThumbnail.headers.get('cache-control'), 'public, max-age=86400');

    const deniedOriginal = await fetch(`${baseUrl}/api/pages/42/image/original`);
    assert.equal(deniedOriginal.status, 401);
    assertPrivateImageHeaders(deniedOriginal);

    const deniedOriginalThumbnail = await fetch(`${baseUrl}/api/pages/42/image/original/thumbnail`);
    assert.equal(deniedOriginalThumbnail.status, 401);
    assertPrivateImageHeaders(deniedOriginalThumbnail);

    const original = await fetch(`${baseUrl}/api/pages/42/image/original`, {
      headers: { Authorization: 'Bearer valid-token' },
    });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), rawImage);
    assert.equal(original.headers.get('content-type'), 'image/png');
    assert.equal(original.headers.get('content-length'), String(rawImage.length));
    assertPrivateImageHeaders(original);

    const originalThumbnail = await fetch(`${baseUrl}/api/pages/42/image/original/thumbnail?width=640`, {
      headers: { Authorization: 'Bearer valid-token' },
    });
    assert.equal(await originalThumbnail.text(), 'thumbnail');
    assert.equal(originalThumbnail.headers.get('content-type'), 'image/avif');
    assertPrivateImageHeaders(originalThumbnail);
  });

  const validatedFilters = fake.calls.flatMap((call) => call.filters)
    .filter((filter) => filter.field === 'statut' && filter.operator === 'eq');
  assert.ok(validatedFilters.length >= 2);
  assert.ok(validatedFilters.every((filter) => filter.value === VALIDATED_BUBBLE_STATUS));
});

test('private image routes reject unsupported stored content without caching it', async () => {
  const fake = createFakeSupabase();
  const activeContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  const router = createPageRouter({
    supabaseClient: fake.client,
    supabaseAdminClient: fake.client,
    optionalAuth: (_req, _res, next) => next(),
    requireAuth: (_req, _res, next) => next(),
    requireRole: () => (_req, _res, next) => next(),
    openImage: async () => ({
      body: Readable.from([activeContent]),
      contentType: 'image/avif',
      contentLength: activeContent.length,
    }),
    readImage: async () => ({ buffer: activeContent, contentType: 'image/avif' }),
  });

  await withServer(router, async (baseUrl) => {
    for (const pathSuffix of ['/image/original', '/image/original/thumbnail']) {
      const response = await fetch(`${baseUrl}/api/pages/42${pathSuffix}`);
      assert.equal(response.status, 415);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assertPrivateImageHeaders(response);
      assert.match((await response.json()).error, /JPEG, PNG, WebP ou AVIF/);
    }
  });
});

test('private image not-found responses retain the non-cacheable security headers', async () => {
  const missingPageClient = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        single: async () => ({ data: null, error: null }),
      };
    },
  };
  const router = createPageRouter({
    supabaseClient: missingPageClient,
    requireAuth: (_req, _res, next) => next(),
  });

  await withServer(router, async (baseUrl) => {
    for (const pathSuffix of ['/image/original', '/image/original/thumbnail']) {
      const response = await fetch(`${baseUrl}/api/pages/missing${pathSuffix}`);
      assert.equal(response.status, 404);
      assertPrivateImageHeaders(response);
    }
  });
});

test('validated search filtering preserves order and drops unreviewed rows', async () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return Promise.resolve({ data: [{ id: 1 }, { id: 3 }], error: null }); },
      };
    },
  };

  assert.deepEqual(await keepValidatedBubbleRows(client, rows), [{ id: 1 }, { id: 3 }]);
});

test('public search serializers and database migration cannot expose stored page URLs', () => {
  const searchSource = fs.readFileSync(path.join(__dirname, '../src/routes/searchRoutes.js'), 'utf8');
  const publicApiSource = fs.readFileSync(path.join(__dirname, '../src/routes/v1/publicRoutes.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../sql/2026-07-31_protect_page_media.sql'), 'utf8');

  assert.doesNotMatch(searchSource, /url_image:\s*(?:c|b|pageRecord)\.url_image/);
  assert.doesNotMatch(publicApiSource, /url:\s*b\.url_image/);
  assert.match(migration, /revoke select on table public\.pages from anon, authenticated/i);
  assert.match(migration, /revoke select on table public\.bulles from anon, authenticated/i);
  assert.match(migration, /where b\.statut = 'Validé'/i);
});
