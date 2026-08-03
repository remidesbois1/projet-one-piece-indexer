import { z } from 'zod';
import inputLimits from '@poneglyph/shared/input-limits.json';

export const MAX_BUBBLE_TEXT_LENGTH = inputLimits.bubbleTextLength;
export const MAX_BUBBLES_PER_PAGE = inputLimits.bubblesPerPage;
export const MAX_SEARCH_QUERY_LENGTH = inputLimits.searchQueryLength;
export const MAX_OCR_BUBBLES = inputLimits.ocrBubbles;
export const MAX_OCR_TEXT_LENGTH = inputLimits.ocrTextLength;

function numberFromString(schema) {
    return z.preprocess((value) => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : value;
    }, schema);
}

const positiveIdSchema = numberFromString(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const coordinateSchema = z.number().finite().int().min(0).max(100_000);
const dimensionSchema = z.number().finite().int().min(1).max(100_000);
const bubbleTextSchema = z.string().trim().min(1).max(MAX_BUBBLE_TEXT_LENGTH);
const pageSchema = numberFromString(z.number().int().min(1).max(100_000));
const characterFiltersSchema = z.array(z.string().trim().min(1).max(100)).max(32);

export const bubbleCreatePayloadSchema = z.object({
    id_page: positiveIdSchema,
    x: coordinateSchema,
    y: coordinateSchema,
    w: dimensionSchema,
    h: dimensionSchema,
    texte_propose: bubbleTextSchema,
    order: z.number().int().min(1).max(MAX_BUBBLES_PER_PAGE).optional().nullable(),
});

export const bubbleUpdatePayloadSchema = z.object({
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    w: dimensionSchema.optional(),
    h: dimensionSchema.optional(),
    texte_propose: bubbleTextSchema.optional(),
}).refine((payload) => Object.keys(payload).length > 0, 'Aucune donnée à mettre à jour.');

export const reorderBubblesPayloadSchema = z.array(z.object({
    id: positiveIdSchema,
    order: z.number().int().min(1).max(MAX_BUBBLES_PER_PAGE),
})).min(1).max(MAX_BUBBLES_PER_PAGE).superRefine((bubbles, context) => {
    const ids = new Set();
    const orders = new Set();
    bubbles.forEach((bubble, index) => {
        if (ids.has(bubble.id)) {
            context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Bulle dupliquée.' });
        }
        if (orders.has(bubble.order)) {
            context.addIssue({ code: 'custom', path: [index, 'order'], message: 'Position dupliquée.' });
        }
        ids.add(bubble.id);
        orders.add(bubble.order);
    });
    const orderedPositions = [...orders].sort((left, right) => left - right);
    if (orderedPositions.some((position, index) => position !== index + 1)) {
        context.addIssue({ code: 'custom', message: 'Les positions doivent être contiguës.' });
    }
});

const optionalTomeFilterSchema = z.preprocess((value) => {
    if (value === '' || value === 'all' || value === undefined) return '';
    return value;
}, z.union([z.literal(''), numberFromString(z.number().int().positive().max(100_000))]));

const searchFiltersSchema = z.object({
    characters: characterFiltersSchema.default([]),
    arc: z.string().trim().max(200).default(''),
    tome: optionalTomeFilterSchema.default(''),
});

export const keywordSearchPayloadSchema = z.object({
    query: z.string().trim().min(2).max(MAX_SEARCH_QUERY_LENGTH),
    page: pageSchema,
    limit: numberFromString(z.number().int().min(1).max(100)),
    mode: z.enum(['keyword', 'semantic']),
    filters: searchFiltersSchema.default({}),
    rerank: z.boolean(),
    localOnly: z.boolean(),
});

export const f2llmSearchPayloadSchema = z.object({
    query: z.string().trim().min(2).max(MAX_SEARCH_QUERY_LENGTH),
    embedding: z.array(z.number().finite()).length(640),
    page: pageSchema,
    limit: numberFromString(z.number().int().min(1).max(100)),
    filters: searchFiltersSchema.default({}),
});

const ocrBboxSchema = z.union([
    z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive() }),
    z.object({ x1: z.number().finite(), y1: z.number().finite(), x2: z.number().finite(), y2: z.number().finite() }),
]);

export const ocrSearchPayloadSchema = z.object({
    bubbles: z.array(z.object({
        content: z.string().trim().min(1).max(2_000),
        bbox: ocrBboxSchema.optional().nullable(),
    })).min(1).max(MAX_OCR_BUBBLES),
    page: pageSchema,
    limit: numberFromString(z.number().int().min(1).max(48)),
    filters: searchFiltersSchema.default({}),
    provider: z.string().trim().min(1).max(80),
    rawText: z.string().max(MAX_OCR_TEXT_LENGTH),
});

export const chapterUploadFieldsSchema = z.object({
    tome_id: positiveIdSchema,
    numero: numberFromString(z.number().int().positive().max(100_000)),
    titre: z.string().trim().min(1, 'Le titre est requis.').max(inputLimits.chapterTitleLength),
});

export const paginationSchema = z.object({
    page: pageSchema,
    limit: numberFromString(z.number().int().min(1).max(100)),
});

export const moderationCommentPayloadSchema = z.object({
    comment: z.string().max(2_000).optional().nullable(),
});

export function parsePositiveId(value) {
    return positiveIdSchema.parse(value);
}
