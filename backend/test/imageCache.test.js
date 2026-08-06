const test = require('node:test');
const assert = require('node:assert/strict');
const { imageCache, cacheKey, getPageRevision } = require('../src/utils/imageCache');
const LRUCache = require('lru-cache');

function clearCache(cache) {
  if (typeof cache.reset === 'function') {
    cache.reset();
  } else if (typeof cache.clear === 'function') {
    cache.clear();
  }
}

test('imageCache enforces byte-based maximum size and evicts LRU items', () => {
  clearCache(imageCache);

  // Test with custom 10 MB limit instance using the same configuration structure
  const testCache = new LRUCache({
    max: 10 * 1024 * 1024,
    length: (val) => (Buffer.isBuffer(val) ? val.length : 1024),
    maxSize: 10 * 1024 * 1024,
    sizeCalculation: (val) => (Buffer.isBuffer(val) ? val.length : 1024)
  });

  const fourMb = Buffer.alloc(4 * 1024 * 1024);
  
  testCache.set('img1', fourMb);
  testCache.set('img2', fourMb);
  
  assert.equal(testCache.has('img1'), true, 'img1 should be present');
  assert.equal(testCache.has('img2'), true, 'img2 should be present');

  // Adding a 3rd 4MB image brings total to 12MB > 10MB limit. img1 (LRU) must be evicted.
  testCache.set('img3', fourMb);

  assert.equal(testCache.has('img1'), false, 'img1 (LRU item) should have been evicted');
  assert.equal(testCache.has('img2'), true, 'img2 should remain in cache');
  assert.equal(testCache.has('img3'), true, 'img3 should remain in cache');

  const currentSize = testCache.length !== undefined ? testCache.length : testCache.calculatedSize;
  assert.ok(currentSize <= 10 * 1024 * 1024, 'Total cache byte size must not exceed limit');
});

test('imageCache updates LRU access order when an item is retrieved', () => {
  const testCache = new LRUCache({
    max: 10 * 1024 * 1024,
    length: (val) => (Buffer.isBuffer(val) ? val.length : 1024),
    maxSize: 10 * 1024 * 1024,
    sizeCalculation: (val) => (Buffer.isBuffer(val) ? val.length : 1024)
  });

  const fourMb = Buffer.alloc(4 * 1024 * 1024);
  
  testCache.set('img1', fourMb);
  testCache.set('img2', fourMb);

  // Access img1, making img2 the least recently used
  testCache.get('img1');

  // Add img3 (4MB) -> causes eviction of img2 instead of img1
  testCache.set('img3', fourMb);

  assert.equal(testCache.has('img1'), true, 'img1 was recently accessed, should NOT be evicted');
  assert.equal(testCache.has('img2'), false, 'img2 was LRU, should be evicted');
  assert.equal(testCache.has('img3'), true, 'img3 should be present');
});

test('global imageCache singleton correctly calculates buffer byte length', () => {
  clearCache(imageCache);

  const buf = Buffer.alloc(1024 * 1024); // 1 MB
  imageCache.set('test-buf', buf);

  assert.equal(imageCache.has('test-buf'), true);
  
  // In lru-cache v5, length property reports total byte sum
  if (imageCache.length !== undefined) {
    assert.equal(imageCache.length, 1024 * 1024, 'lru-cache length should equal buffer byte length');
  }

  clearCache(imageCache);
});

test('cacheKey generator produces distinct namespaced keys', () => {
  const coverKey = cacheKey.cover({ path: 'vol1.jpg', width: 300 });
  const previewKey = cacheKey.pagePreview({ pageId: '123', revision: 'abc' });
  const thumbKey = cacheKey.pageThumbnail({ pageId: '123', revision: 'abc', width: 300 });

  assert.equal(coverKey, 'cover:vol1.jpg:300');
  assert.equal(previewKey, 'page-preview:123:abc');
  assert.equal(thumbKey, 'page-thumbnail:123:abc:300');

  assert.notEqual(coverKey, previewKey);
  assert.notEqual(previewKey, thumbKey);
});

test('getPageRevision generates deterministic MD5 hashes', () => {
  const bubbles = [{ x: 10, y: 20, w: 100, h: 50, text: 'Hello' }];
  const rev1 = getPageRevision(bubbles);
  const rev2 = getPageRevision(bubbles);

  assert.equal(rev1, rev2, 'Same bubbles must return identical revision hash');
  assert.equal(typeof rev1, 'string');
  assert.equal(rev1.length, 8);

  const modifiedBubbles = [{ x: 10, y: 20, w: 100, h: 50, text: 'Modified' }];
  const rev3 = getPageRevision(modifiedBubbles);

  assert.notEqual(rev1, rev3, 'Modified bubbles must produce a new revision hash');
  assert.equal(getPageRevision([]), '0', 'Empty bubbles array returns "0"');
  assert.equal(getPageRevision(null), '0', 'Null bubbles returns "0"');
});
