import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(rootDir, 'packages', 'shared', 'src', 'model-registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const checkOnly = process.argv.includes('--check');
const publishedModels = Object.entries(registry.models).filter(([, model]) => model.benchmark?.status === 'published');

function formatMetric(metric) {
    const numericValue = metric.unit === 'ratio' ? metric.value * 100 : metric.value;
    const value = numericValue.toFixed(metric.display_precision).replace('.', ',');
    return `${metric.label} ${value}${metric.unit === 'ratio' ? ' %' : ''}`;
}

function formatMetrics(model) {
    return Object.values(model.benchmark.metrics).map(formatMetric).join(' · ');
}

function shortRevision(model) {
    return model.artifact.revision.slice(0, 12);
}

function sourceLink(model, label = 'source') {
    return `[${label}](${model.benchmark.source_url})`;
}

function validateRegistry() {
    const failures = [];
    if (registry.schema_version !== 1) failures.push('schema_version must be 1');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(registry.updated_at || '')) failures.push('updated_at must be an ISO date');

    for (const [id, model] of Object.entries(registry.models)) {
        if (!model.display_name || !model.task || !model.artifact?.repository || !model.artifact?.revision) {
            failures.push(`${id}: incomplete model identity`);
        }
        if (model.benchmark?.status !== 'published') continue;
        const benchmark = model.benchmark;
        for (const field of ['dataset', 'split', 'date', 'hardware', 'protocol', 'source_url', 'primary_metric']) {
            if (!benchmark[field]) failures.push(`${id}: missing benchmark.${field}`);
        }
        if (!Number.isInteger(benchmark.sample_count) || benchmark.sample_count <= 0) {
            failures.push(`${id}: sample_count must be a positive integer`);
        }
        if (!benchmark.metrics?.[benchmark.primary_metric]) failures.push(`${id}: primary metric is missing`);
        if (!benchmark.source_url.includes(model.artifact.revision)) failures.push(`${id}: source URL is not pinned to the model revision`);
        for (const [metricId, metric] of Object.entries(benchmark.metrics || {})) {
            if (!Number.isFinite(metric.value)) failures.push(`${id}.${metricId}: value must be finite`);
            if (!metric.label || !metric.unit || !Number.isInteger(metric.display_precision)) {
                failures.push(`${id}.${metricId}: incomplete metric display metadata`);
            }
        }
    }

    if (failures.length) throw new Error(`Invalid model registry:\n- ${failures.join('\n- ')}`);
}

function renderReadmeBlock() {
    const rows = publishedModels.map(([, model]) => {
        const benchmark = model.benchmark;
        const version = `[${shortRevision(model)}](${model.artifact.url}/tree/${model.artifact.revision})`;
        return `| ${model.display_name} | ${formatMetrics(model)} | ${benchmark.dataset} — ${benchmark.split} | ${benchmark.date} · ${benchmark.sample_count.toLocaleString('fr-FR')} | ${benchmark.hardware} | ${version} · ${sourceLink(model)} |`;
    });

    return [
        '<!-- model-registry:start -->',
        `> Tableau généré depuis \`shared/model-registry.json\` (registre v${registry.schema_version}, ${registry.updated_at}). Les protocoles complets sont publiés dans [la fiche de provenance](documentation/generated/model-benchmarks.md).`,
        '',
        '| Modèle | Résultat publié | Dataset et split | Date et échantillons | Matériel | Version et preuve |',
        '|---|---|---|---|---|---|',
        ...rows,
        '<!-- model-registry:end -->',
    ].join('\n');
}

function renderBenchmarkDocument() {
    const sections = publishedModels.map(([id, model]) => {
        const benchmark = model.benchmark;
        const metricRows = Object.entries(benchmark.metrics).map(([metricId, metric]) =>
            `| \`${metricId}\` | ${formatMetric(metric)} | ${metric.lower_is_better ? 'plus bas' : 'plus haut'} |`
        );
        return [
            `## ${model.display_name}`,
            '',
            `- Identifiant registre : \`${id}\``,
            `- Tâche : \`${model.task}\``,
            `- Version : [\`${model.artifact.repository}@${model.artifact.revision}\`](${model.artifact.url}/tree/${model.artifact.revision})`,
            `- Dataset : ${benchmark.dataset}`,
            `- Split : ${benchmark.split}`,
            `- Date : ${benchmark.date}`,
            `- Échantillons : ${benchmark.sample_count.toLocaleString('fr-FR')}`,
            `- Matériel : ${benchmark.hardware}`,
            `- Protocole : ${benchmark.protocol}`,
            `- Preuve : ${sourceLink(model, 'artefact figé')}`,
            '',
            '| Clé | Valeur | Sens favorable |',
            '|---|---:|---|',
            ...metricRows,
        ].join('\n');
    });

    return [
        '# Benchmarks modèles publiés',
        '',
        `Ce document est généré depuis \`shared/model-registry.json\` (v${registry.schema_version}, ${registry.updated_at}). Ne pas modifier manuellement.`,
        '',
        'Les résultats ne sont comparables qu’à protocole et tâche identiques. Un matériel non consigné est indiqué explicitement plutôt que supposé.',
        '',
        ...sections.flatMap((section, index) => index ? ['', section] : [section]),
        '',
    ].join('\n');
}

function renderHuggingFaceFragment(id, model) {
    const benchmark = model.benchmark;
    return [
        `## Projet Poneglyph benchmark (${registry.updated_at})`,
        '',
        `Registry ID: \`${id}\``,
        `Pinned revision: \`${model.artifact.revision}\``,
        '',
        '| Metric | Value |',
        '|---|---:|',
        ...Object.values(benchmark.metrics).map(metric => `| ${metric.label} | ${formatMetric(metric).replace(`${metric.label} `, '')} |`),
        '',
        `- Dataset: ${benchmark.dataset}`,
        `- Split: ${benchmark.split}`,
        `- Date: ${benchmark.date}`,
        `- Samples: ${benchmark.sample_count}`,
        `- Hardware: ${benchmark.hardware}`,
        `- Protocol: ${benchmark.protocol}`,
        `- Evidence: ${benchmark.source_url}`,
        '',
        '> Generated from `shared/model-registry.json`; update the registry and rerun `node scripts/render-model-registry.mjs`.',
        '',
    ].join('\n');
}

function renderReleaseNotes() {
    return [
        '# Model benchmark release notes',
        '',
        `Generated from model registry v${registry.schema_version} on ${registry.updated_at}.`,
        '',
        ...publishedModels.flatMap(([id, model]) => [
            `## ${model.display_name}`,
            '',
            `- Registry ID: \`${id}\``,
            `- Published version: \`${model.artifact.repository}@${model.artifact.revision}\``,
            `- Result: ${formatMetrics(model)}`,
            `- Evaluation: ${model.benchmark.dataset}, ${model.benchmark.split}, ${model.benchmark.sample_count} samples, ${model.benchmark.date}`,
            `- Hardware: ${model.benchmark.hardware}`,
            `- Protocol and evidence: ${model.benchmark.protocol} ${model.benchmark.source_url}`,
            '',
        ]),
    ].join('\n');
}

const mismatches = [];

function syncFile(relativePath, expected) {
    const absolutePath = path.join(rootDir, relativePath);
    const normalized = `${expected.replace(/\r\n/g, '\n').trimEnd()}\n`;
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === normalized) return;
    if (checkOnly) {
        mismatches.push(relativePath);
        return;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, normalized, 'utf8');
}

function syncReadme() {
    const readmePath = path.join(rootDir, 'README.md');
    const current = fs.readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n');
    const start = '<!-- model-registry:start -->';
    const end = '<!-- model-registry:end -->';
    const startIndex = current.indexOf(start);
    const endIndex = current.indexOf(end);
    if (startIndex < 0 || endIndex < startIndex) throw new Error('README model registry markers are missing or invalid');
    const expected = `${current.slice(0, startIndex)}${renderReadmeBlock()}${current.slice(endIndex + end.length)}`;
    syncFile('README.md', expected);
}

validateRegistry();
syncReadme();
syncFile('documentation/generated/model-benchmarks.md', renderBenchmarkDocument());
syncFile('documentation/generated/model-release-notes.md', renderReleaseNotes());
for (const [id, model] of publishedModels) {
    syncFile(`documentation/generated/hugging-face/${id}.md`, renderHuggingFaceFragment(id, model));
}

if (mismatches.length) {
    console.error(`Generated model registry files are stale:\n- ${mismatches.join('\n- ')}`);
    process.exitCode = 1;
} else {
    console.log(checkOnly ? 'Model registry outputs are up to date.' : 'Model registry outputs updated.');
}
