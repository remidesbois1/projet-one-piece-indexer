import { createModalOcrHandler } from '@/lib/server/modalOcrProxy';

export const runtime = 'nodejs';
export const maxDuration = 190;

export const POST = createModalOcrHandler({
    id: 'poneglyph_one_shot',
    urlEnv: 'MODAL_PONEGLYPH_BBOX_URL',
    quotaCost: 5,
    allowAnonymous: false,
    timeoutMs: 180_000,
    responseKind: 'bubbles',
});
