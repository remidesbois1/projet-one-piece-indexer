import { describe, expect, it } from 'vitest';
import { half, packImage, resizedDimensions, roundEven, smartDimensions } from './falconPreprocessing';

describe('Falcon browser preprocessing', () => {
    it('encodes normalized pixels as IEEE float16, including subnormals', () => {
        expect([0, -0, 1, -1, 65504, 2 ** -14, 2 ** -24].map(half))
            .toEqual([0, 0x8000, 0x3c00, 0xbc00, 0x7bff, 0x0400, 1]);
    });
    it('matches Python rounding and the two resizing budgets', () => {
        expect([2.5, 3.5, 4.5].map(roundEven)).toEqual([2, 4, 4]);
        expect(resizedDimensions(160, 96)).toEqual([160, 96]);
        expect(resizedDimensions(32, 64)).toEqual([64, 128]);
        expect(smartDimensions(72, 88)).toEqual([64, 96]);
    });
    it('preserves patch order, image bidirectionality and text causality', () => {
        const manifest = {
            prompt_chunks: [[], [100, 101]],
            config: { image_cls_token_id: 244, image_reg_1_token_id: 245, image_reg_2_token_id: 246,
                image_reg_3_token_id: 247, image_reg_4_token_id: 248, img_id: 227, img_end_id: 230 },
            golden_frequencies: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => [1, 0])),
        };
        const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(255);
        rgba[0] = 0;
        const batch = packImage(manifest, rgba, 32, 32);
        expect(batch.ids).toEqual([244,245,246,247,248,227,227,227,227,230,100,101]);
        expect(batch.pixels[5 * 768]).toBe(half(-1));
        expect(batch.pixels[5 * 768 + 1]).toBe(half(1));
        expect(batch.attention[8]).toBe(0);
        expect(batch.attention[9]).toBe(half(-10000));
        expect(batch.attention[10 * 12 + 11]).toBe(half(-10000));
        expect(batch.lastPosition).toBe(2);
        expect(batch.cos[(5 * 16) * 32 + 16]).toBeCloseTo(Math.cos(-1), 6);
    });
});
