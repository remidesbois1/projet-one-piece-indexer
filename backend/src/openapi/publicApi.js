const PUBLIC_API_VERSIONS = Object.freeze({
  v2: Object.freeze({ status: 'stable', recommended: true }),
  v1: Object.freeze({ status: 'deprecated', recommended: false }),
});

const PUBLIC_API_ROUTE_PATHS = Object.freeze({
  v1: Object.freeze([
    '/v1/status',
    '/v1/tomes',
    '/v1/tomes/{tomeNumero}/chapters',
    '/v1/search',
    '/v1/stats',
    '/v1/quotes/random',
    '/v1/chapters/{numero}',
    '/v1/chapters/{chapterNo}/pages/{pageNo}',
  ]),
  v2: Object.freeze([
    '/v2/series/{seriesSlug}/volumes/{volumeNumber}/chapters',
    '/v2/series/{seriesSlug}/chapters/{chapterNumber}/pages/{pageNumber}',
  ]),
});

const jsonContent = (schema) => ({
  content: { 'application/json': { schema } },
});

const response = (description, schema) => ({ description, ...jsonContent(schema) });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorResponses = {
  400: response('Invalid route or query parameters.', ref('Error')),
  404: response('Resource not found.', ref('Error')),
  500: response('Internal server error.', ref('Error')),
};
const pathParameter = (name, description) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: name === 'seriesSlug'
    ? { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100 }
    : { type: 'integer', minimum: 1, maximum: 100000 },
});
const paginationParameters = [
  {
    name: 'page',
    in: 'query',
    description: 'One-based result page.',
    schema: { type: 'integer', minimum: 1, default: 1 },
  },
  {
    name: 'page_size',
    in: 'query',
    description: 'Number of results per page.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
];

function legacyOperation(operationId, summary, { parameters = [] } = {}) {
  return {
    operationId,
    summary,
    deprecated: true,
    tags: ['Legacy v1'],
    parameters,
    responses: {
      200: response('Legacy response. Its shape is frozen for compatibility.', { type: 'object', additionalProperties: true }),
      ...errorResponses,
    },
  };
}

const publicApiSpec = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Projet Poneglyph Public API',
    version: '2.0.0',
    description: 'Read-only public access to validated manga indexing data. v2 is series-scoped; v1 is deprecated compatibility only.',
  },
  servers: [{ url: 'https://api.poneglyph.fr', description: 'Production' }],
  tags: [
    { name: 'Public v2', description: 'Stable, series-scoped endpoints.' },
    { name: 'Legacy v1', description: 'Deprecated compatibility endpoints; no new integrations should depend on them.' },
  ],
  paths: {
    '/openapi.json': {
      get: {
        operationId: 'getPublicApiContract',
        summary: 'Download the public API contract',
        tags: ['Public v2'],
        responses: { 200: response('OpenAPI 3.1 document.', { type: 'object' }) },
      },
    },
    '/v1/status': { get: legacyOperation('getLegacyStatus', 'Get legacy API status') },
    '/v1/tomes': { get: legacyOperation('listLegacyVolumes', 'List volumes without a series scope') },
    '/v1/tomes/{tomeNumero}/chapters': {
      get: legacyOperation('listLegacyVolumeChapters', 'List chapters by an ambiguous volume number', {
        parameters: [pathParameter('tomeNumero', 'Legacy volume number.')],
      }),
    },
    '/v1/search': {
      get: legacyOperation('searchLegacyBubbles', 'Search validated bubbles', {
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
        ],
      }),
    },
    '/v1/stats': { get: legacyOperation('getLegacyStats', 'Get global statistics') },
    '/v1/quotes/random': {
      get: legacyOperation('getLegacyRandomQuote', 'Get a random validated quote', {
        parameters: [{ name: 'min_length', in: 'query', schema: { type: 'integer', minimum: 1, default: 15 } }],
      }),
    },
    '/v1/chapters/{numero}': {
      get: legacyOperation('getLegacyChapter', 'Get a chapter by an ambiguous number', {
        parameters: [pathParameter('numero', 'Legacy chapter number.')],
      }),
    },
    '/v1/chapters/{chapterNo}/pages/{pageNo}': {
      get: legacyOperation('getLegacyChapterPage', 'Get a page by ambiguous chapter and page numbers', {
        parameters: [
          pathParameter('chapterNo', 'Legacy chapter number.'),
          pathParameter('pageNo', 'Page number.'),
        ],
      }),
    },
    '/v2/series/{seriesSlug}/volumes/{volumeNumber}/chapters': {
      get: {
        operationId: 'listSeriesVolumeChapters',
        summary: 'List chapters in a series volume',
        tags: ['Public v2'],
        parameters: [
          pathParameter('seriesSlug', 'Stable series slug.'),
          pathParameter('volumeNumber', 'Volume number inside the series.'),
          ...paginationParameters,
        ],
        responses: {
          200: response('A paginated chapter collection.', ref('ChapterCollection')),
          ...errorResponses,
        },
      },
    },
    '/v2/series/{seriesSlug}/chapters/{chapterNumber}/pages/{pageNumber}': {
      get: {
        operationId: 'getSeriesChapterPage',
        summary: 'Get a page and its validated bubbles inside a series',
        tags: ['Public v2'],
        parameters: [
          pathParameter('seriesSlug', 'Stable series slug.'),
          pathParameter('chapterNumber', 'Chapter number inside the series.'),
          pathParameter('pageNumber', 'Page number inside the chapter.'),
          ...paginationParameters,
        ],
        responses: {
          200: response('A page with a paginated list of validated bubbles.', ref('PageResponse')),
          409: response('The chapter number is duplicated inside the requested series.', ref('Error')),
          ...errorResponses,
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          code: { type: 'string' },
        },
        additionalProperties: false,
      },
      Pagination: {
        type: 'object',
        required: ['page', 'page_size', 'total_items', 'total_pages'],
        properties: {
          page: { type: 'integer', minimum: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 100 },
          total_items: { type: 'integer', minimum: 0 },
          total_pages: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
      PaginationLinks: {
        type: 'object',
        required: ['self', 'first', 'previous', 'next', 'last'],
        properties: {
          self: { type: ['string', 'null'] },
          first: { type: ['string', 'null'] },
          previous: { type: ['string', 'null'] },
          next: { type: ['string', 'null'] },
          last: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      Series: {
        type: 'object',
        required: ['id', 'slug', 'title'],
        properties: {
          id: { type: 'integer' },
          slug: { type: 'string' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      Volume: {
        type: 'object',
        required: ['id', 'number', 'series_id', 'series_slug'],
        properties: {
          id: { type: 'integer' },
          number: { type: 'integer' },
          title: { type: ['string', 'null'] },
          series_id: { type: 'integer' },
          series_slug: { type: 'string' },
        },
        additionalProperties: false,
      },
      Chapter: {
        type: 'object',
        required: ['id', 'series_id', 'series_slug', 'volume_id', 'volume_number', 'chapter_number'],
        properties: {
          id: { type: 'integer' },
          series_id: { type: 'integer' },
          series_slug: { type: 'string' },
          volume_id: { type: 'integer' },
          volume_number: { type: 'integer' },
          chapter_number: { type: 'integer' },
          title: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      ChapterCollection: {
        type: 'object',
        required: ['series', 'volume', 'data', 'pagination', 'links'],
        properties: {
          series: ref('Series'),
          volume: ref('Volume'),
          data: { type: 'array', items: ref('Chapter') },
          pagination: ref('Pagination'),
          links: ref('PaginationLinks'),
        },
        additionalProperties: false,
      },
      PublicMetadata: {
        type: 'object',
        required: ['arc', 'characters'],
        properties: {
          arc: { type: ['string', 'null'] },
          characters: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      Bubble: {
        type: 'object',
        required: ['id', 'content', 'order'],
        properties: {
          id: { type: 'integer' },
          content: { type: 'string' },
          order: { type: ['integer', 'null'] },
        },
        additionalProperties: false,
      },
      Page: {
        type: 'object',
        required: [
          'id', 'series_id', 'series_slug', 'volume_id', 'volume_number',
          'chapter_id', 'chapter_number', 'page_number', 'image_url', 'metadata', 'bubbles',
        ],
        properties: {
          id: { type: 'integer' },
          series_id: { type: 'integer' },
          series_slug: { type: 'string' },
          volume_id: { type: 'integer' },
          volume_number: { type: 'integer' },
          chapter_id: { type: 'integer' },
          chapter_number: { type: 'integer' },
          page_number: { type: 'integer' },
          image_url: { type: 'string' },
          metadata: ref('PublicMetadata'),
          bubbles: { type: 'array', items: ref('Bubble') },
        },
        additionalProperties: false,
      },
      PageResponse: {
        type: 'object',
        required: ['data', 'pagination', 'links'],
        properties: {
          data: ref('Page'),
          pagination: ref('Pagination'),
          links: ref('PaginationLinks'),
        },
        additionalProperties: false,
      },
    },
  },
});

module.exports = { PUBLIC_API_ROUTE_PATHS, PUBLIC_API_VERSIONS, publicApiSpec };
