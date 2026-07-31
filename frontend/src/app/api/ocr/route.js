import { createModalOcrHandler } from '@/lib/server/modalOcrProxy';

export const runtime = 'nodejs';
export const maxDuration = 130;

export const POST = createModalOcrHandler({
    id: 'ocr',
    urlEnv: 'MODAL_OCR_URL',
    quotaCost: 2,
    allowAnonymous: false,
    timeoutMs: 120_000,
    responseKind: 'text',
});
