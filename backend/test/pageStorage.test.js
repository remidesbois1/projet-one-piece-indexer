const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPageStorageRef,
  getPrivatePagesBucketName,
  openPageImage,
  parsePageStorageRef,
  readPageImage,
} = require('../src/utils/pageStorage');

test('private page references round-trip without a public URL', () => {
  const reference = createPageStorageRef('private-pages', 'tome-1/chapitre-2/page 3.avif');
  assert.equal(reference, 'r2://private-pages/tome-1/chapitre-2/page%203.avif');
  assert.deepEqual(parsePageStorageRef(reference), {
    bucket: 'private-pages',
    key: 'tome-1/chapitre-2/page 3.avif',
  });
});

test('legacy configured R2 URLs are read through authenticated object storage', async () => {
  const previousPublicUrl = process.env.R2_PUBLIC_URL;
  const previousBucket = process.env.R2_BUCKET_NAME;
  process.env.R2_PUBLIC_URL = 'https://media.example.test';
  process.env.R2_BUCKET_NAME = 'legacy-pages';

  const requests = [];
  const client = {
    async send(command) {
      requests.push(command.input);
      return {
        Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) },
        ContentType: 'image/avif',
        ContentLength: 3,
      };
    },
  };

  try {
    const image = await readPageImage('https://media.example.test/tome-1/page.avif', { client });
    assert.deepEqual(requests, [{ Bucket: 'legacy-pages', Key: 'tome-1/page.avif' }]);
    assert.deepEqual(image.buffer, Buffer.from([1, 2, 3]));
    assert.equal(image.contentType, 'image/avif');
  } finally {
    if (previousPublicUrl === undefined) delete process.env.R2_PUBLIC_URL;
    else process.env.R2_PUBLIC_URL = previousPublicUrl;
    if (previousBucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = previousBucket;
  }
});

test('original page reads expose the R2 body without buffering it first', async () => {
  const body = {
    transformToByteArray: async () => {
      throw new Error('the streaming path must not buffer the full object');
    },
  };
  const client = {
    async send() {
      return { Body: body, ContentType: 'image/webp', ContentLength: 1234 };
    },
  };

  const image = await openPageImage('r2://private-pages/chapter/page.webp', { client });

  assert.equal(image.body, body);
  assert.equal(image.contentType, 'image/webp');
  assert.equal(image.contentLength, 1234);
});

test('production uploads fail closed without a dedicated private page bucket', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPagesBucket = process.env.R2_PAGES_BUCKET_NAME;
  process.env.NODE_ENV = 'production';
  delete process.env.R2_PAGES_BUCKET_NAME;

  try {
    assert.throws(() => getPrivatePagesBucketName(), /private bucket/i);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPagesBucket === undefined) delete process.env.R2_PAGES_BUCKET_NAME;
    else process.env.R2_PAGES_BUCKET_NAME = previousPagesBucket;
  }
});

test('unconfigured external URLs are rejected instead of fetched server-side', () => {
  assert.throws(
    () => parsePageStorageRef('https://attacker.example/page.png'),
    /configured R2 storage/
  );
});
