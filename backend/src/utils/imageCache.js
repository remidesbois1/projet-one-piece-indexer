const LRUCache = require('lru-cache');
const crypto = require('crypto');

const MAX_CACHE_SIZE_MB = 100;

const imageCache = new LRUCache({
    max: MAX_CACHE_SIZE_MB * 1024 * 1024,
    length: (value) => (Buffer.isBuffer(value) ? value.length : 1024),
    maxSize: MAX_CACHE_SIZE_MB * 1024 * 1024,
    sizeCalculation: (value) => (Buffer.isBuffer(value) ? value.length : 1024)
});

const cacheKey = {
    cover: ({ path, width }) => `cover:${path}:${width}`,
    pagePreview: ({ pageId, revision }) => `page-preview:${pageId}:${revision}`,
    pageThumbnail: ({ pageId, revision, width }) => `page-thumbnail:${pageId}:${revision}:${width}`,
};

function getPageRevision(bubbles) {
    if (!bubbles || bubbles.length === 0) return '0';
    return crypto.createHash('md5').update(JSON.stringify(bubbles)).digest('hex').substring(0, 8);
}

module.exports = {
    imageCache,
    cacheKey,
    getPageRevision
};
