import { describe, expect, it } from 'vitest';

import { canDownloadMissingLocalModel } from './localModelRecovery';


describe('canDownloadMissingLocalModel', () => {
    it('keeps re-download available when integrity failure sets an error', () => {
        expect(canDownloadMissingLocalModel({
            installed: false,
            error: "Le modele a echoue au controle d'integrite.",
        })).toBe(true);
    });

    it('does not download an installed model or start a duplicate download', () => {
        expect(canDownloadMissingLocalModel({ installed: true })).toBe(false);
        expect(canDownloadMissingLocalModel({ installed: false }, true)).toBe(false);
    });
});
