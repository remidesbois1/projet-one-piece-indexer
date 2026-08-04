const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');
const registry = require('@poneglyph/shared/model-registry.json');

test('published model metrics carry complete pinned provenance', () => {
    for (const [id, model] of Object.entries(registry.models)) {
        assert.ok(model.display_name, `${id}: display_name`);
        assert.ok(model.artifact?.revision, `${id}: artifact revision`);
        if (model.benchmark.status !== 'published') continue;

        for (const field of ['dataset', 'split', 'date', 'hardware', 'protocol', 'source_url', 'primary_metric']) {
            assert.ok(model.benchmark[field], `${id}: benchmark.${field}`);
        }
        assert.ok(Number.isInteger(model.benchmark.sample_count) && model.benchmark.sample_count > 0);
        assert.ok(model.benchmark.source_url.includes(model.artifact.revision), `${id}: unpinned source URL`);
        assert.ok(model.benchmark.metrics[model.benchmark.primary_metric], `${id}: missing primary metric`);
        for (const metric of Object.values(model.benchmark.metrics)) {
            assert.ok(Number.isFinite(metric.value));
            assert.ok(metric.value >= 0);
            if (metric.unit === 'ratio') assert.ok(metric.value <= 1);
        }
    }
});

test('generated README, model-card fragments and release notes match the registry', () => {
    const result = spawnSync(process.execPath, ['scripts/render-model-registry.mjs', '--check'], {
        cwd: rootDir,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('frontend marketing surfaces do not contain legacy CER claims', () => {
    const files = [
        'frontend/src/context/WorkerContext.jsx',
        'frontend/src/components/LandingPageClient.jsx',
        'frontend/src/components/AnnotateOcrModelSelector.jsx',
        'frontend/src/components/ModelBenchmarkRegistry.jsx',
    ];
    const source = files.map(file => fs.readFileSync(path.join(rootDir, file), 'utf8')).join('\n');
    assert.doesNotMatch(source, /<\s*0[.,]1\s*%/i);
    assert.doesNotMatch(source, /CER\s+1[.,]92\s*%/i);
    assert.doesNotMatch(source, /CER\s+~\s*0[.,]5\s*%/i);
    assert.match(source, /formatRegistryMetric/);
});
