const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PUBLIC_API_ROUTE_PATHS,
  PUBLIC_API_VERSIONS,
  publicApiSpec,
} = require('../src/openapi/publicApi');

const repositoryRoot = path.join(__dirname, '..', '..');

function extractGetRoutes(sourcePath, mountPath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const routes = [];
  const pattern = /router\.get\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const openApiPath = match[1].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    routes.push(`${mountPath}${openApiPath}`);
  }
  return routes.sort();
}

test('OpenAPI declares every mounted public route and no removed README routes', () => {
  const v1Source = path.join(__dirname, '..', 'src', 'routes', 'v1', 'publicRoutes.js');
  const v2Source = path.join(__dirname, '..', 'src', 'routes', 'v2', 'publicRoutes.js');
  const runtimeV1 = extractGetRoutes(v1Source, '/v1');
  const runtimeV2 = extractGetRoutes(v2Source, '/v2');
  assert.deepEqual(runtimeV1, [...PUBLIC_API_ROUTE_PATHS.v1].sort());
  assert.deepEqual(runtimeV2, [...PUBLIC_API_ROUTE_PATHS.v2].sort());

  const documentedRoutes = Object.keys(publicApiSpec.paths).sort();
  assert.deepEqual(documentedRoutes, ['/openapi.json', ...runtimeV1, ...runtimeV2].sort());

  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(indexSource, /app\.use\('\/v1', publicLimiter, publicRoutes\)/);
  assert.match(indexSource, /app\.use\('\/v2', publicLimiter, publicV2Routes\)/);
  assert.match(indexSource, /app\.get\('\/openapi\.json', publicLimiter/);
});

test('OpenAPI 3.1 operations are uniquely identified and mark only v1 deprecated', () => {
  assert.equal(publicApiSpec.openapi, '3.1.0');
  assert.equal(publicApiSpec.info.title, 'Projet Poneglyph Public API');
  assert.deepEqual(PUBLIC_API_VERSIONS, {
    v2: { status: 'stable', recommended: true },
    v1: { status: 'deprecated', recommended: false },
  });

  const operationIds = [];
  for (const [route, pathItem] of Object.entries(publicApiSpec.paths)) {
    const operation = pathItem.get;
    assert.ok(operation, `${route} must expose GET in the contract`);
    assert.ok(operation.responses?.['200'], `${route} must document a 200 response`);
    operationIds.push(operation.operationId);
    if (route.startsWith('/v1/')) assert.equal(operation.deprecated, true, route);
    if (route.startsWith('/v2/')) assert.notEqual(operation.deprecated, true, route);
  }
  assert.equal(new Set(operationIds).size, operationIds.length);

  const chapterSchema = publicApiSpec.components.schemas.Chapter;
  const pageSchema = publicApiSpec.components.schemas.Page;
  assert.ok(chapterSchema.required.includes('series_slug'));
  assert.ok(pageSchema.required.includes('series_slug'));
  assert.ok(publicApiSpec.components.schemas.Pagination.required.includes('total_pages'));
});

test('README documents the supported versions and contains no fictitious public route', () => {
  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  assert.match(readme, /API Publique recommandée[^\n]*\/v2/);
  assert.match(readme, /\/openapi\.json/);
  assert.match(readme, /\*\*v2\*\* \| Stable, recommandée/);
  assert.match(readme, /\*\*v1\*\* \| Dépréciée/);
  assert.match(readme, /\/series\/\{seriesSlug\}\/volumes\/\{volumeNumber\}\/chapters/);
  assert.doesNotMatch(readme, /`\/series`\s*\|/);
  assert.doesNotMatch(readme, /`\/tomes\/:id`/);
  assert.doesNotMatch(readme, /`\/pages\/:id`/);
});

test('product-facing identity no longer uses the retired project name', () => {
  const files = [
    path.join(repositoryRoot, 'README.md'),
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', 'src', 'routes', 'v1', 'publicRoutes.js'),
    path.join(repositoryRoot, 'frontend', 'src', 'app', 'sandbox', 'page.jsx'),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /One Piece Indexer/i, file);
  }
  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /^projet-one-piece-indexer\/$/m);
  assert.match(readme, /^projet-poneglyph\/$/m);
});

test('the served contract is JSON serializable without losing paths', () => {
  const serialized = JSON.stringify(publicApiSpec);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.info.version, '2.0.0');
  assert.deepEqual(Object.keys(parsed.paths).sort(), Object.keys(publicApiSpec.paths).sort());
});
