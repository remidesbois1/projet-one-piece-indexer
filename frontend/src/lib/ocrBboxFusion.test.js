import { describe, expect, it } from 'vitest';
import { reconcileOcrBubblesWithYolo } from './ocrBboxFusion';

describe('reconcileOcrBubblesWithYolo', () => {
    it('uses the best YOLO geometry while preserving OCR text and reading order', () => {
        const result = reconcileOcrBubblesWithYolo([
            { content: 'Premier', bbox: [100, 100, 300, 300] },
            { content: 'Deuxième', bbox: [600, 600, 800, 800] },
        ], [
            { x: 610, y: 605, w: 185, h: 190 },
            { x: 95, y: 105, w: 210, h: 180 },
        ], 1000, 1000);

        expect(result).toEqual([
            expect.objectContaining({ content: 'Premier', x: 95, y: 105, w: 210, h: 180, ralliedWithYolo: true }),
            expect.objectContaining({ content: 'Deuxième', x: 610, y: 605, w: 185, h: 190, ralliedWithYolo: true }),
        ]);
    });

    it('matches each YOLO box once and falls back to the normalized OCR geometry', () => {
        const result = reconcileOcrBubblesWithYolo([
            { content: 'A', bbox: [100, 100, 300, 300] },
            { content: 'B', bbox: [120, 120, 320, 320] },
            { content: 'C', bbox: [700, 700, 900, 900] },
        ], [{ x: 105, y: 105, w: 200, h: 200 }], 1000, 1000);

        expect(result.filter(item => item.ralliedWithYolo)).toHaveLength(1);
        expect(result[2]).toEqual(expect.objectContaining({ content: 'C', x: 700, y: 700, w: 200, h: 200, ralliedWithYolo: false }));
    });
});
