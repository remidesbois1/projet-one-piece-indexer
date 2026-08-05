const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const inputLimits = require('@poneglyph/shared/input-limits.json');
const { MAX_PAGE_IMAGE_BYTES } = require('../src/utils/pageStorage');

test('every backend R2 client pins bucket names to the endpoint path', () => {
  for (const relativePath of [
    '../src/utils/pageStorage.js',
    '../src/routes/adminRoutes.js',
    '../src/services/chapterImportStorage.js',
    '../scripts/migrate_pages_to_private_r2.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    assert.match(source, /forcePathStyle:\s*true/);
  }
});

test('page reads pass a bounded AbortSignal to the S3 request', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/pageStorage.js'), 'utf8');
  assert.match(source, /client\.send\([\s\S]*?abortSignal:\s*abortContext\.signal/);
  assert.equal(MAX_PAGE_IMAGE_BYTES, inputLimits.pageImageBytes);
});

test('page uploads validate bounded bytes and canonical keys before object storage', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
  assert.match(source, /const upload = multer\(\{ storage: storage \}\)/);
  assert.match(source, /const pageUpload = multer\(\{[\s\S]*?fileSize:\s*inputLimits\.pageImageBytes/);
  assert.match(source, /router\.post\('\/upload\/page'[\s\S]*?uploadSinglePage/);

  const routeStart = source.indexOf("router.post('/upload/page'");
  const routeSource = source.slice(routeStart, source.indexOf("router.post('/tomes/batch-pages'", routeStart));
  assert.ok(routeSource.indexOf('normalizePageStorageKey(key)') < routeSource.indexOf('new PutObjectCommand'));
  assert.match(routeSource, /Key:\s*normalizedKey/);
  assert.match(routeSource, /clearBubbleGeometryCache\(\)/);
  assert.match(routeSource, /createPageStorageRef\(pagesBucketName, normalizedKey\)/);
});

test('bubble crops never fetch stored URLs directly and return private raster responses', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/bulleRoutes.js'), 'utf8');
  const routeStart = source.indexOf("router.get('/:id/crop'");
  const routeSource = source.slice(routeStart, source.indexOf("router.put('/:id'", routeStart));
  assert.match(routeSource, /readPageImage\(bubble\.pages\.url_image\)/);
  assert.doesNotMatch(routeSource, /\b(?:axios|fetch)\s*\(/);
  assert.match(routeSource, /createBubbleCrop\(imageBuffer, bubble\)/);
  assert.match(routeSource, /Cache-Control', 'private, no-store'/);
  assert.match(routeSource, /PAGE_IMAGE_TOO_LARGE[\s\S]*PAGE_IMAGE_TIMEOUT/);
});
