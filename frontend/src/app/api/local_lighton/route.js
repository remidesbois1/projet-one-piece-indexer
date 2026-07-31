import { createModalOcrHandler } from '@/lib/server/modalOcrProxy';

export const runtime = 'nodejs';
export const maxDuration = 130;

export const POST = createModalOcrHandler({
    id: 'local_lighton',
    urlEnv: 'MODAL_LIGHTON_URL',
    quotaCost: 1,
    allowAnonymous: false,
    timeoutMs: 120_000,
    responseKind: 'text',
});
