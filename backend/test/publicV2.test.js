const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const {
  createPublicV2Repository,
  createPublicV2Router,
  parsePagination,
  parseSeriesSlug,
} = require('../src/routes/v2/publicRoutes');
const {
  createPublicApiAccessMiddleware,
  getClientIp,
} = require('../src/middleware/publicApiAccess');
const { VALIDATED_BUBBLE_STATUS } = require('../src/utils/publicMedia');

async function withServer(router, callback) {
  const app = express();
  app.use('/v2', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}/v2`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const SERIES = { id: 7, slug: 'one-piece', titre: 'One Piece', enabled: true };
const VOLUME = { id: 11, numero: 1, titre: 'Romance Dawn', mangas: SERIES };
const PAGE = {
  id: 31,
  numero_page: 3,
  description: { content: 'private draft', metadata: { arc: 'East Blue', characters: ['Luffy'] } },
  chapitres: {
    id: 21,
    numero: 1,
    titre: 'Romance Dawn',
    tomes: VOLUME,
  },
};

test('v2 chapter lists are scoped by series and expose stable IDs with standard pagination', async () => {
  const calls = [];
  const repository = {
    async findVolume(slug, number) {
      calls.push(['findVolume', slug, number]);
      return VOLUME;
    },
    async listChapters(volumeId, pagination) {
      calls.push(['listChapters', volumeId, pagination.from, pagination.to]);
      return {
        total: 5,
        rows: [
          { id: 23, numero: 3, titre: 'Chapter 3' },
          { id: 24, numero: 4, titre: 'Chapter 4' },
        ],
      };
    },
  };
  const router = createPublicV2Router({
    repository,
    accessMiddleware: (_req, _res, next) => next(),
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/series/one-piece/volumes/1/chapters?page=2&page_size=2`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.series.slug, 'one-piece');
    assert.equal(body.volume.id, 11);
    assert.equal(body.volume.series_slug, 'one-piece');
    assert.deepEqual(body.data.map((chapter) => chapter.id), [23, 24]);
    assert.ok(body.data.every((chapter) => chapter.series_slug === 'one-piece' && chapter.volume_id === 11));
    assert.deepEqual(body.pagination, {
      page: 2,
      page_size: 2,
      total_items: 5,
      total_pages: 3,
    });
    assert.equal(body.links.self, '/v2/series/one-piece/volumes/1/chapters?page=2&page_size=2');
    assert.equal(body.links.previous, '/v2/series/one-piece/volumes/1/chapters?page=1&page_size=2');
    assert.equal(body.links.next, '/v2/series/one-piece/volumes/1/chapters?page=3&page_size=2');
  });

  assert.deepEqual(calls, [
    ['findVolume', 'one-piece', 1],
    ['listChapters', 11, 2, 3],
  ]);
});

test('v2 page lookup keeps the series scope and paginates validated bubbles', async () => {
  const calls = [];
  const repository = {
    async findPages(slug, chapterNumber, pageNumber) {
      calls.push(['findPages', slug, chapterNumber, pageNumber]);
      return [PAGE];
    },
    async listBubbles(pageId, pagination) {
      calls.push(['listBubbles', pageId, pagination.from, pagination.to]);
      return { rows: [{ id: 41, texte_propose: 'Je serai le roi des pirates !', order: 1 }], total: 2 };
    },
  };
  const router = createPublicV2Router({
    repository,
    accessMiddleware: (_req, _res, next) => next(),
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/series/one-piece/chapters/1/pages/3?page=1&page_size=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.id, 31);
    assert.equal(body.data.series_id, 7);
    assert.equal(body.data.series_slug, 'one-piece');
    assert.equal(body.data.volume_id, 11);
    assert.equal(body.data.chapter_id, 21);
    assert.equal(body.data.image_url, '/api/pages/31/image');
    assert.deepEqual(body.data.metadata, { arc: 'East Blue', characters: ['Luffy'] });
    assert.deepEqual(body.data.bubbles, [{ id: 41, content: 'Je serai le roi des pirates !', order: 1 }]);
    assert.equal(JSON.stringify(body).includes('private draft'), false);
    assert.equal(body.pagination.total_pages, 2);
  });

  assert.deepEqual(calls, [
    ['findPages', 'one-piece', 1, 3],
    ['listBubbles', 31, 0, 0],
  ]);
});

test('v2 rejects malformed routes and refuses ambiguous chapter numbers', async () => {
  let lookups = 0;
  const repository = {
    async findVolume() { lookups += 1; return VOLUME; },
    async listChapters() { return { rows: [], total: 0 }; },
    async findPages() { lookups += 1; return [PAGE, { ...PAGE, id: 32 }]; },
  };
  const router = createPublicV2Router({
    repository,
    accessMiddleware: (_req, _res, next) => next(),
  });

  await withServer(router, async (baseUrl) => {
    for (const path of [
      '/series/One-Piece/volumes/1/chapters',
      '/series/one-piece/volumes/01/chapters',
      '/series/one-piece/volumes/1/chapters?page=0',
      '/series/one-piece/volumes/1/chapters?page_size=101',
      '/series/one-piece/chapters/-1/pages/3',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 400, path);
    }
    assert.equal(lookups, 0);

    const ambiguous = await fetch(`${baseUrl}/series/one-piece/chapters/1/pages/3`);
    assert.equal(ambiguous.status, 409);
    const body = await ambiguous.json();
    assert.equal(body.code, 'AMBIGUOUS_CHAPTER_NUMBER');
  });
});

function createRecordingClient(responses) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        const state = { table, filters: [], orders: [], select: null, range: null, limit: null };
        calls.push(state);
        const query = {
          select(value, options) { state.select = value; state.selectOptions = options; return query; },
          eq(field, value) { state.filters.push(['eq', field, value]); return query; },
          not(field, operator, value) { state.filters.push(['not', field, operator, value]); return query; },
          neq(field, value) { state.filters.push(['neq', field, value]); return query; },
          order(field, options) { state.orders.push([field, options]); return query; },
          range(from, to) { state.range = [from, to]; return query; },
          limit(value) { state.limit = value; return query; },
          maybeSingle() { return Promise.resolve(responses[table]); },
          then(resolve, reject) { return Promise.resolve(responses[table]).then(resolve, reject); },
        };
        return query;
      },
    },
  };
}

test('v2 repository pushes series filters and pagination into single bounded queries', async () => {
  const recording = createRecordingClient({
    tomes: { data: VOLUME, error: null },
    chapitres: { data: [], error: null, count: 0 },
    pages: { data: [PAGE], error: null },
    bulles: { data: [], error: null, count: 0 },
  });
  const repository = createPublicV2Repository(recording.client);
  await repository.findVolume('one-piece', 1);
  await repository.listChapters(11, { from: 20, to: 39 });
  await repository.findPages('one-piece', 1, 3);
  await repository.listBubbles(31, { from: 0, to: 49 });

  const volumeQuery = recording.calls.find((call) => call.table === 'tomes');
  assert.ok(volumeQuery.filters.some((filter) => filter[1] === 'mangas.slug' && filter[2] === 'one-piece'));
  assert.ok(volumeQuery.filters.some((filter) => filter[1] === 'mangas.enabled' && filter[2] === true));
  const chapterQuery = recording.calls.find((call) => call.table === 'chapitres');
  assert.deepEqual(chapterQuery.range, [20, 39]);
  assert.equal(chapterQuery.selectOptions.count, 'exact');
  const pageQuery = recording.calls.find((call) => call.table === 'pages');
  assert.ok(pageQuery.filters.some((filter) => filter[1] === 'chapitres.tomes.mangas.slug'));
  assert.equal(pageQuery.limit, 2);
  const bubbleQuery = recording.calls.find((call) => call.table === 'bulles');
  assert.ok(bubbleQuery.filters.some((filter) => filter[1] === 'statut' && filter[2] === VALIDATED_BUBBLE_STATUS));
  assert.deepEqual(bubbleQuery.range, [0, 49]);
});

test('public API access rules cache empty and populated ban lists', async () => {
  let reads = 0;
  let currentTime = 1_000;
  const client = {
    from() {
      return {
        select: async () => {
          reads += 1;
          return { data: reads === 1 ? [] : [{ ip: '203.0.113.7' }], error: null };
        },
      };
    },
  };
  const middleware = createPublicApiAccessMiddleware({ client, cacheTtlMs: 100, now: () => currentTime });
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  let nextCalls = 0;
  const request = { headers: { 'cf-connecting-ip': '203.0.113.7' }, connection: {} };

  await middleware(request, response, () => { nextCalls += 1; });
  await middleware(request, response, () => { nextCalls += 1; });
  assert.equal(reads, 1, 'an empty ban list must still be cached');
  assert.equal(nextCalls, 2);

  currentTime += 101;
  await middleware(request, response, () => { nextCalls += 1; });
  assert.equal(reads, 2);
  assert.equal(response.statusCode, 403);
  assert.equal(nextCalls, 2);
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }, connection: {} }), '198.51.100.2');
  assert.equal(getClientIp({ headers: { 'cf-connecting-ip': ['::ffff:198.51.100.3'] }, connection: {} }), '198.51.100.3');
});

test('v2 parameter parsers reject coercion and bound page sizes', () => {
  assert.equal(parseSeriesSlug('one-piece'), 'one-piece');
  assert.throws(() => parseSeriesSlug('one_piece'), { statusCode: 400 });
  assert.deepEqual(parsePagination({ page: '2', page_size: '25' }), {
    page: 2,
    pageSize: 25,
    from: 25,
    to: 49,
  });
  assert.throws(() => parsePagination({ page: '2.5' }), { statusCode: 400 });
});
