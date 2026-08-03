import { describe, expect, it } from 'vitest';

import {
    MAX_BUBBLE_TEXT_LENGTH,
    MAX_BUBBLES_PER_PAGE,
    MAX_OCR_BUBBLES,
    MAX_SEARCH_QUERY_LENGTH,
    bubbleCreatePayloadSchema,
    bubbleUpdatePayloadSchema,
    chapterUploadFieldsSchema,
    f2llmSearchPayloadSchema,
    keywordSearchPayloadSchema,
    ocrSearchPayloadSchema,
    parsePositiveId,
    reorderBubblesPayloadSchema,
} from './inputSchemas';

describe('shared input schemas', () => {
    it('sanitizes bubble payloads and rejects invalid geometry', () => {
        const parsed = bubbleCreatePayloadSchema.parse({
            id_page: '42', x: 0, y: 1, w: 2, h: 3, texte_propose: 'Texte', tempId: 'optimistic',
        });
        expect(parsed).toEqual({ id_page: 42, x: 0, y: 1, w: 2, h: 3, texte_propose: 'Texte' });
        expect(() => bubbleCreatePayloadSchema.parse({ ...parsed, x: -1 })).toThrow();
        expect(() => bubbleCreatePayloadSchema.parse({ ...parsed, w: 0 })).toThrow();
        expect(() => bubbleCreatePayloadSchema.parse({ ...parsed, x: Number.NaN })).toThrow();
        expect(() => bubbleCreatePayloadSchema.parse({ ...parsed, texte_propose: '   ' })).toThrow();
        expect(() => bubbleCreatePayloadSchema.parse({ ...parsed, texte_propose: 'x'.repeat(MAX_BUBBLE_TEXT_LENGTH + 1) })).toThrow();
        expect(() => bubbleUpdatePayloadSchema.parse({})).toThrow();
    });

    it('rejects duplicate and oversized reorder payloads', () => {
        expect(reorderBubblesPayloadSchema.parse([{ id: 1, order: 1 }, { id: 2, order: 2 }])).toHaveLength(2);
        expect(() => reorderBubblesPayloadSchema.parse([{ id: 1, order: 1 }, { id: 1, order: 2 }])).toThrow();
        expect(() => reorderBubblesPayloadSchema.parse([{ id: 1, order: 1 }, { id: 2, order: 1 }])).toThrow();
        expect(() => reorderBubblesPayloadSchema.parse([{ id: 1, order: 1 }, { id: 2, order: 3 }])).toThrow();
        expect(() => reorderBubblesPayloadSchema.parse(
            Array.from({ length: MAX_BUBBLES_PER_PAGE + 1 }, (_, index) => ({ id: index + 1, order: index + 1 }))
        )).toThrow();
    });

    it('bounds search payloads and embeddings', () => {
        const request = keywordSearchPayloadSchema.parse({
            query: '  luffy  ', page: '1', limit: '10', mode: 'keyword', filters: {}, rerank: false, localOnly: false,
        });
        expect(request.query).toBe('luffy');
        expect(request.filters).toEqual({ characters: [], arc: '', tome: '' });
        expect(() => keywordSearchPayloadSchema.parse({ ...request, query: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) })).toThrow();
        expect(() => keywordSearchPayloadSchema.parse({ ...request, limit: 101 })).toThrow();
        expect(() => keywordSearchPayloadSchema.parse({ ...request, filters: { tome: '1abc' } })).toThrow();

        const embedding = Array(640).fill(0.1);
        expect(f2llmSearchPayloadSchema.parse({ query: 'luffy', embedding, page: 1, limit: 10, filters: {} }).embedding).toHaveLength(640);
        expect(() => f2llmSearchPayloadSchema.parse({ query: 'luffy', embedding: embedding.slice(1), page: 1, limit: 10, filters: {} })).toThrow();
        expect(() => f2llmSearchPayloadSchema.parse({ query: 'luffy', embedding: [...embedding.slice(0, 639), Infinity], page: 1, limit: 10, filters: {} })).toThrow();
    });

    it('bounds OCR payloads, IDs and upload metadata', () => {
        const base = {
            bubbles: [{ content: 'Texte', bbox: [0, 0, 10, 10] }],
            page: 1,
            limit: 24,
            filters: {},
            provider: 'ppocr',
            rawText: '',
        };
        expect(ocrSearchPayloadSchema.parse(base).bubbles).toHaveLength(1);
        expect(() => ocrSearchPayloadSchema.parse({ ...base, bubbles: Array(MAX_OCR_BUBBLES + 1).fill(base.bubbles[0]) })).toThrow();
        expect(() => parsePositiveId(true)).toThrow();
        expect(() => parsePositiveId('0x10')).toThrow();
        expect(() => parsePositiveId('1e2')).toThrow();
        expect(parsePositiveId('7')).toBe(7);
        expect(chapterUploadFieldsSchema.parse({ tome_id: '7', numero: '2', titre: '  Titre  ' })).toEqual({
            tome_id: 7, numero: 2, titre: 'Titre',
        });
    });
});
