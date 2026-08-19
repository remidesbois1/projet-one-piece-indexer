import { describe, expect, it } from 'vitest';

import { getGeminiGenerationConfig } from './geminiClient';

describe('getGeminiGenerationConfig', () => {
    it('leaves Gemini thinking automatic when no level is selected', () => {
        expect(getGeminiGenerationConfig(
            { gemini_thinking_level: 'default' },
            { responseMimeType: 'application/json' }
        )).toEqual({ responseMimeType: 'application/json' });
    });

    it('maps none to a zero token budget', () => {
        expect(getGeminiGenerationConfig({ gemini_thinking_level: 'none' })).toEqual({
            thinkingConfig: { thinkingBudget: 0 },
        });
    });

    it('maps named levels to the Gemini enum value', () => {
        expect(getGeminiGenerationConfig({ gemini_thinking_level: 'medium' })).toEqual({
            thinkingConfig: { thinkingLevel: 'MEDIUM' },
        });
    });
});
