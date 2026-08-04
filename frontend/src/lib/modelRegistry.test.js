import { describe, expect, it } from 'vitest';
import {
    MODEL_REGISTRY,
    OCR_MODEL_REGISTRY_IDS,
    PUBLISHED_MODEL_BENCHMARKS,
    formatBenchmarkContext,
    formatRegistryMetric,
    getModelRegistryEntry,
} from './modelRegistry';

describe('model registry', () => {
    it('publishes only traceable finite metrics', () => {
        expect(PUBLISHED_MODEL_BENCHMARKS.length).toBeGreaterThan(0);
        for (const model of PUBLISHED_MODEL_BENCHMARKS) {
            const benchmark = model.benchmark;
            expect(benchmark.dataset).toBeTruthy();
            expect(benchmark.split).toBeTruthy();
            expect(benchmark.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(benchmark.hardware).toBeTruthy();
            expect(benchmark.protocol).toBeTruthy();
            expect(benchmark.sample_count).toBeGreaterThan(0);
            expect(benchmark.source_url).toContain(model.artifact.revision);
            expect(benchmark.metrics[benchmark.primary_metric]).toBeTruthy();
            Object.values(benchmark.metrics).forEach(metric => expect(Number.isFinite(metric.value)).toBe(true));
        }
    });

    it('formats the exact published values used by the UI', () => {
        expect(formatRegistryMetric('lighton-bubble')).toBe('CER 0,424 %');
        expect(formatRegistryMetric('surya-bubble')).toBe('CER 0,451 %');
        expect(formatRegistryMetric('ppocrv6-line')).toBe('CER 1,451 %');
        expect(formatRegistryMetric('one-shot-reading-order')).toBe('Exact page 96,77 %');
        expect(formatRegistryMetric('gemini-flash-lite')).toBe('Benchmark comparable non publié');
    });

    it('maps every selectable OCR model to a registry entry', () => {
        for (const registryId of Object.values(OCR_MODEL_REGISTRY_IDS)) {
            expect(getModelRegistryEntry(registryId)).toBeTruthy();
        }
        expect(formatBenchmarkContext('surya-bubble')).toContain('1');
        expect(MODEL_REGISTRY.schema_version).toBe(1);
    });
});
