import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    useInterceptor: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        create: () => ({
            get: apiMocks.get,
            post: apiMocks.post,
            interceptors: {
                request: { use: apiMocks.useInterceptor },
            },
        }),
    },
}));

vi.mock('./supabaseClient', () => ({
    supabase: {
        auth: { getSession: vi.fn() },
    },
}));

import { searchBubbles, searchF2llmLocal, searchOcrPageMatch } from './api';

describe('search API cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes the same AbortSignal to keyword, local and OCR transports', () => {
        const signal = new AbortController().signal;

        searchBubbles('gold roger', 1, 24, 'keyword', {}, false, false, { signal });
        searchF2llmLocal({
            query: 'gold roger',
            embedding: Array(640).fill(0),
            page: 1,
            limit: 24,
            filters: {},
            signal,
        });
        searchOcrPageMatch({
            bubbles: [{ content: 'gold roger', bbox: { x: 1, y: 2, w: 3, h: 4 } }],
            page: 1,
            limit: 3,
            filters: {},
            provider: 'test',
            rawText: 'gold roger',
            signal,
        });

        expect(apiMocks.get).toHaveBeenCalledWith(
            expect.stringMatching(/^\/search\?/),
            { signal }
        );
        expect(apiMocks.post).toHaveBeenNthCalledWith(
            1,
            '/search/f2llm-local',
            expect.any(Object),
            { signal }
        );
        expect(apiMocks.post).toHaveBeenNthCalledWith(
            2,
            '/search/ocr-match',
            expect.any(Object),
            { signal }
        );
    });
});
