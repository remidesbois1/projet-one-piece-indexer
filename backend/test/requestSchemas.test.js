const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_BUBBLE_TEXT_LENGTH,
  MAX_BUBBLES_PER_PAGE,
  MAX_OCR_BUBBLES,
  MAX_SEARCH_QUERY_LENGTH,
  bubbleCreateSchema,
  bubbleUpdateSchema,
  chapterUploadBodySchema,
  f2llmSearchBodySchema,
  ocrSearchBodySchema,
  pendingBubblesQuerySchema,
  reorderBubblesSchema,
  searchQuerySchema,
  validateRequest,
} = require('../src/validation/requestSchemas');

const validBubble = {
  id_page: 42,
  x: 10,
  y: 20,
  w: 30,
  h: 40,
  texte_propose: 'Texte',
};

test('bubble schemas reject malformed geometry, oversized text and mass assignment', () => {
  assert.equal(bubbleCreateSchema.safeParse(validBubble).success, true);
  assert.equal(bubbleCreateSchema.safeParse({ ...validBubble, x: -1 }).success, false);
  assert.equal(bubbleCreateSchema.safeParse({ ...validBubble, w: 0 }).success, false);
  assert.equal(bubbleCreateSchema.safeParse({ ...validBubble, h: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(bubbleCreateSchema.safeParse({ ...validBubble, x: 1.5 }).success, false);
  assert.equal(bubbleCreateSchema.safeParse({ ...validBubble, texte_propose: 'x'.repeat(MAX_BUBBLE_TEXT_LENGTH + 1) }).success, false);
  assert.equal(bubbleCreateSchema.safeParse({ ...validBubble, statut: 'Validé' }).success, false);
  assert.equal(bubbleUpdateSchema.safeParse({}).success, false);
  assert.equal(bubbleUpdateSchema.safeParse({ texte_propose: '' }).success, false);
});

test('reorder schema rejects duplicates, invalid positions and massive lists', () => {
  assert.equal(reorderBubblesSchema.safeParse({
    pageId: 9,
    orderedBubbles: [{ id: 1, order: 1 }, { id: 2, order: 2 }],
  }).success, true);
  assert.equal(reorderBubblesSchema.safeParse({
    pageId: 9,
    orderedBubbles: [{ id: 1, order: 1 }, { id: 1, order: 2 }],
  }).success, false);
  assert.equal(reorderBubblesSchema.safeParse({
    pageId: 9,
    orderedBubbles: [{ id: 1, order: 1 }, { id: 2, order: 1 }],
  }).success, false);
  assert.equal(reorderBubblesSchema.safeParse({ pageId: 9, orderedBubbles: [{ id: 1, order: 0 }] }).success, false);
  assert.equal(reorderBubblesSchema.safeParse({
    pageId: 9,
    orderedBubbles: [{ id: 1, order: 1 }, { id: 2, order: 3 }],
  }).success, false);
  assert.equal(reorderBubblesSchema.safeParse({
    pageId: 9,
    orderedBubbles: Array.from({ length: MAX_BUBBLES_PER_PAGE + 1 }, (_, index) => ({ id: index + 1, order: index + 1 })),
  }).success, false);
  assert.equal(reorderBubblesSchema.safeParse({
    pageId: 0,
    orderedBubbles: [{ id: 1, order: 1 }],
  }).success, false);
  assert.equal(reorderBubblesSchema.safeParse({
    orderedBubbles: [{ id: 1, order: 1 }],
  }).success, false);
});

test('pagination and chapter upload parsing is strict and bounded', () => {
  assert.deepEqual(pendingBubblesQuerySchema.parse({}), { page: 1, limit: 5 });
  assert.deepEqual(pendingBubblesQuerySchema.parse({ page: '2', limit: '100' }), { page: 2, limit: 100 });
  assert.equal(pendingBubblesQuerySchema.safeParse({ page: '1abc', limit: 5 }).success, false);
  assert.equal(pendingBubblesQuerySchema.safeParse({ page: '1e2', limit: 5 }).success, false);
  assert.equal(pendingBubblesQuerySchema.safeParse({ page: 1, limit: 101 }).success, false);
  assert.equal(pendingBubblesQuerySchema.safeParse({ page: true, limit: 5 }).success, false);
  assert.deepEqual(chapterUploadBodySchema.parse({ tome_id: '7', numero: '12', titre: '  Le chapitre  ' }), {
    tome_id: 7,
    numero: 12,
    titre: 'Le chapitre',
  });
  assert.equal(chapterUploadBodySchema.safeParse({ tome_id: 7, numero: 1.5, titre: 'Titre' }).success, false);
  assert.equal(chapterUploadBodySchema.safeParse({ tome_id: '0x10', numero: 1, titre: 'Titre' }).success, false);
});

test('search schemas cap query, filters, embeddings and OCR payloads', () => {
  assert.deepEqual(searchQuerySchema.parse({ q: '  luffy  ' }), {
    q: 'luffy',
    page: 1,
    limit: 10,
    mode: 'keyword',
    rerank: false,
  });
  assert.equal(searchQuerySchema.safeParse({ q: 'x' }).success, false);
  assert.equal(searchQuerySchema.safeParse({ q: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) }).success, false);
  assert.equal(searchQuerySchema.safeParse({ q: 'luffy', limit: 0 }).success, false);
  assert.equal(searchQuerySchema.safeParse({ q: 'luffy', tome: '1abc' }).success, false);
  assert.equal(searchQuerySchema.safeParse({ q: 'luffy', characters: JSON.stringify(Array(33).fill('Luffy')) }).success, false);

  const embedding = Array(640).fill(0.1);
  assert.equal(f2llmSearchBodySchema.safeParse({ query: 'luffy', embedding }).success, true);
  assert.equal(f2llmSearchBodySchema.safeParse({ query: 'luffy', embedding: embedding.slice(1) }).success, false);
  assert.equal(f2llmSearchBodySchema.safeParse({ query: 'luffy', embedding: [...embedding.slice(0, 639), Number.NaN] }).success, false);

  const ocrBubble = { content: 'Gomu gomu', bbox: [0, 0, 10, 10] };
  assert.equal(ocrSearchBodySchema.safeParse({ bubbles: [ocrBubble] }).success, true);
  assert.equal(ocrSearchBodySchema.safeParse({ bubbles: [{ ...ocrBubble, content: '' }] }).success, false);
  assert.equal(ocrSearchBodySchema.safeParse({ bubbles: [{ ...ocrBubble, bbox: [0, 0, Number.POSITIVE_INFINITY, 10] }] }).success, false);
  assert.equal(ocrSearchBodySchema.safeParse({ bubbles: Array(MAX_OCR_BUBBLES + 1).fill(ocrBubble) }).success, false);
});

test('validation middleware returns normalized data and structured errors', () => {
  const middleware = validateRequest({ query: pendingBubblesQuerySchema });
  const req = { query: { page: '3', limit: '10' } };
  let nextCalled = false;
  middleware(req, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.validated.query, { page: 3, limit: 10 });

  const invalidReq = { query: { page: '-1', limit: '500' } };
  let statusCode;
  let payload;
  middleware(invalidReq, {
    status(value) { statusCode = value; return this; },
    json(value) { payload = value; return this; },
  }, () => assert.fail('next should not be called'));
  assert.equal(statusCode, 400);
  assert.equal(payload.error, 'Données invalides.');
  assert.ok(payload.details.some((detail) => detail.path === 'page'));
});

test('database constraints mirror the bounded bubble contract for new writes', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'sql', '2026-08-01_validate_bubble_inputs.sql'),
    'utf8'
  );
  assert.match(migration, /bulles_geometry_is_positive/);
  assert.match(migration, /char_length\(btrim\(texte_propose\)\) between 1 and 20000/);
  assert.match(migration, /"order" between 1 and 2000/);
  assert.match(migration, /not valid/gi);
});
