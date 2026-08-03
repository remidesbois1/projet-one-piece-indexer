const { z } = require('zod');
const inputLimits = require('@poneglyph/shared/input-limits.json');

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const MAX_BUBBLE_TEXT_LENGTH = inputLimits.bubbleTextLength;
const MAX_BUBBLES_PER_PAGE = inputLimits.bubblesPerPage;
const MAX_COORDINATE = inputLimits.coordinate;
const MAX_SEARCH_QUERY_LENGTH = inputLimits.searchQueryLength;
const MAX_OCR_TEXT_LENGTH = inputLimits.ocrTextLength;
const MAX_OCR_BUBBLES = inputLimits.ocrBubbles;
const MAX_FILTER_CHARACTERS = inputLimits.filterCharacters;

function numberFromString(schema) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : value;
  }, schema);
}

function booleanFromString(defaultValue = false) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean());
}

function optionalPositiveInteger({ max = MAX_SAFE_ID } = {}) {
  return numberFromString(z.number().int().positive().max(max)).optional();
}

const positiveIdSchema = numberFromString(
  z.number().int().positive().max(MAX_SAFE_ID)
);
const coordinateSchema = z.number().finite().int().min(0).max(MAX_COORDINATE);
const dimensionSchema = z.number().finite().int().min(1).max(MAX_COORDINATE);
const bubbleTextSchema = z.string().trim().min(1).max(MAX_BUBBLE_TEXT_LENGTH);
const orderSchema = z.number().int().min(1).max(MAX_BUBBLES_PER_PAGE);
const pageSchema = numberFromString(z.number().int().min(1).max(100_000)).default(1);
const limitSchema = (max, fallback) => numberFromString(
  z.number().int().min(1).max(max)
).default(fallback);
const mangaSlugSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/i);

const bubbleGeometrySchema = z.object({
  x: coordinateSchema,
  y: coordinateSchema,
  w: dimensionSchema,
  h: dimensionSchema,
}).strict();

const bubbleCreateSchema = bubbleGeometrySchema.extend({
  id_page: positiveIdSchema,
  texte_propose: bubbleTextSchema,
  order: orderSchema.optional().nullable(),
}).strict();

const bubbleUpdateSchema = z.object({
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  w: dimensionSchema.optional(),
  h: dimensionSchema.optional(),
  texte_propose: bubbleTextSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Aucune donnée à mettre à jour.',
});

const reorderBubbleItemSchema = z.object({
  id: positiveIdSchema,
  order: orderSchema,
}).strict();

const reorderBubblesSchema = z.object({
  pageId: positiveIdSchema,
  orderedBubbles: z.array(reorderBubbleItemSchema).min(1).max(MAX_BUBBLES_PER_PAGE),
}).strict().superRefine(({ orderedBubbles }, context) => {
  const ids = new Set();
  const orders = new Set();
  orderedBubbles.forEach((bubble, index) => {
    if (ids.has(bubble.id)) {
      context.addIssue({
        code: 'custom',
        path: ['orderedBubbles', index, 'id'],
        message: 'Chaque bulle ne peut apparaître qu’une fois.',
      });
    }
    if (orders.has(bubble.order)) {
      context.addIssue({
        code: 'custom',
        path: ['orderedBubbles', index, 'order'],
        message: 'Chaque position doit être unique.',
      });
    }
    ids.add(bubble.id);
    orders.add(bubble.order);
  });
  const orderedPositions = [...orders].sort((left, right) => left - right);
  if (orderedPositions.some((position, index) => position !== index + 1)) {
    context.addIssue({
      code: 'custom',
      path: ['orderedBubbles'],
      message: 'Les positions doivent être contiguës de 1 au nombre de bulles.',
    });
  }
});

const idParamsSchema = z.object({ id: positiveIdSchema }).strict();
const pageIdParamsSchema = z.object({ pageId: positiveIdSchema }).strict();
const chapterIdParamsSchema = z.object({ chapterId: positiveIdSchema }).strict();

const pendingBubblesQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema(100, 5),
}).strict();

const moderationCommentSchema = z.object({
  comment: z.string().max(2_000).optional().nullable(),
}).strict();

function parseCharactersInput(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return [value];
  }
}

const filterCharactersSchema = z.preprocess(
  parseCharactersInput,
  z.array(z.string().trim().min(1).max(100)).max(MAX_FILTER_CHARACTERS).optional()
);
const optionalFilterStringSchema = z.preprocess(
  (value) => value === '' || value === 'all' ? undefined : value,
  z.string().trim().max(200).optional()
);
const optionalTomeSchema = z.preprocess(
  (value) => value === '' || value === 'all' ? undefined : value,
  optionalPositiveInteger({ max: 100_000 })
);

const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(MAX_SEARCH_QUERY_LENGTH),
  page: pageSchema,
  limit: limitSchema(100, 10),
  mode: z.enum(['keyword', 'semantic']).default('keyword'),
  characters: filterCharactersSchema,
  arc: optionalFilterStringSchema,
  tome: optionalTomeSchema,
  manga: mangaSlugSchema.optional(),
  rerank: booleanFromString(false),
  local_only: booleanFromString(false).optional(),
  localOnly: booleanFromString(false).optional(),
}).strict();

const searchContextQuerySchema = z.object({
  manga: mangaSlugSchema.optional(),
}).strict();

const f2llmSearchBodySchema = z.object({
  query: z.string().trim().min(2).max(MAX_SEARCH_QUERY_LENGTH),
  embedding: z.array(z.number().finite()).length(640),
  page: pageSchema,
  limit: limitSchema(100, 10),
  characters: filterCharactersSchema,
  arc: optionalFilterStringSchema,
  tome: optionalTomeSchema,
}).strict();

const bboxTupleSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const bboxXywhSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
}).strict();
const bboxCornersSchema = z.object({
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
}).strict();
const ocrBboxSchema = z.union([bboxTupleSchema, bboxXywhSchema, bboxCornersSchema]);
const ocrBubbleSchema = z.object({
  content: z.string().max(2_000).optional(),
  text: z.string().max(2_000).optional(),
  texte_propose: z.string().max(2_000).optional(),
  bbox: ocrBboxSchema.optional().nullable(),
  pos: ocrBboxSchema.optional().nullable(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().finite().positive().optional(),
  h: z.number().finite().positive().optional(),
}).strict().refine((bubble) => {
  const content = bubble.content ?? bubble.text ?? bubble.texte_propose;
  return typeof content === 'string' && content.trim().length > 0;
}, { message: 'Chaque bulle OCR doit contenir du texte.' });

const ocrSearchBodySchema = z.object({
  bubbles: z.array(ocrBubbleSchema).min(1).max(MAX_OCR_BUBBLES),
  page: pageSchema,
  limit: limitSchema(48, 24),
  manga: mangaSlugSchema.optional(),
  characters: filterCharactersSchema,
  arc: optionalFilterStringSchema,
  tome: optionalTomeSchema,
  provider: z.string().trim().min(1).max(80).default('unknown'),
  raw_text: z.string().max(MAX_OCR_TEXT_LENGTH).optional(),
}).strict();

const chapterUploadBodySchema = z.object({
  tome_id: positiveIdSchema,
  numero: numberFromString(z.number().int().positive().max(100_000)),
  titre: z.string().trim().min(1).max(inputLimits.chapterTitleLength),
}).strict();

function formatValidationIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function validateRequest(schemas, { onInvalid } = {}) {
  return (req, res, next) => {
    const validated = {};
    for (const [source, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[source] || {});
      if (!result.success) {
        if (onInvalid) {
          try {
            onInvalid(req);
          } catch (cleanupError) {
            console.error('Impossible de nettoyer la requête invalide:', cleanupError.message);
          }
        }
        return res.status(400).json({
          error: 'Données invalides.',
          details: formatValidationIssues(result.error),
        });
      }
      validated[source] = result.data;
    }
    req.validated = { ...(req.validated || {}), ...validated };
    return next();
  };
}

module.exports = {
  MAX_BUBBLE_TEXT_LENGTH,
  MAX_BUBBLES_PER_PAGE,
  MAX_OCR_BUBBLES,
  MAX_OCR_TEXT_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  bubbleCreateSchema,
  bubbleGeometrySchema,
  bubbleUpdateSchema,
  chapterIdParamsSchema,
  chapterUploadBodySchema,
  f2llmSearchBodySchema,
  idParamsSchema,
  moderationCommentSchema,
  ocrSearchBodySchema,
  pageIdParamsSchema,
  pendingBubblesQuerySchema,
  positiveIdSchema,
  reorderBubblesSchema,
  searchContextQuerySchema,
  searchQuerySchema,
  validateRequest,
};
