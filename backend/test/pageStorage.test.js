const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  MAX_PAGE_IMAGE_BYTES,
  PageStorageError,
  createPageStorageRef,
  getPrivatePagesBucketName,
  openPageImage,
  parsePageStorageRef,
  readPageImage,
  normalizePageStorageKey,
} = require('../src/utils/pageStorage');

const STORAGE_OPTIONS = Object.freeze({
  allowedBuckets: ['private-pages'],
  legacyPublicUrl: 'https://media.example.test',
  legacyBucket: 'legacy-pages',
});

function storageOptions(overrides = {}) {
  return { ...STORAGE_OPTIONS, ...overrides };
}

function assertStorageError(code, statusCode) {
  return (error) => (
    error instanceof PageStorageError
    && error.code === code
    && (statusCode === undefined || error.statusCode === statusCode)
  );
}

test('private page references round-trip only through an explicitly allowed bucket', () => {
  const reference = createPageStorageRef('private-pages', 'tome-1/chapitre-2/page 3.avif');
  assert.equal(reference, 'r2://private-pages/tome-1/chapitre-2/page%203.avif');
  assert.deepEqual(parsePageStorageRef(reference, STORAGE_OPTIONS), {
    bucket: 'private-pages',
    key: 'tome-1/chapitre-2/page 3.avif',
  });

  for (const rejected of [
    'r2://private-pages-attacker/page.avif',
    'r2://private-pages.evil/page.avif',
    'r2://legacy-pages/page.avif',
    'r2://legacy-pages.evil/page.avif',
  ]) {
    assert.throws(
      () => parsePageStorageRef(rejected, STORAGE_OPTIONS),
      (error) => ['PAGE_BUCKET_NOT_ALLOWED', 'INVALID_PAGE_BUCKET'].includes(error.code)
    );
  }
});

test('R2 references reject credentials, URL state, traversal and non-canonical encodings', () => {
  for (const rejected of [
    'r2://user@private-pages/page.avif',
    'r2://private-pages:443/page.avif',
    'r2://private-pages/page.avif?download=1',
    'r2://private-pages/page.avif#fragment',
    'r2://private-pages/a/../page.avif',
    'r2://private-pages/a/%2e%2e/page.avif',
    'r2://private-pages/foo%2Fbar.avif',
    'r2://private-pages/page%2eavif',
    'r2://PRIVATE-PAGES/page.avif',
    ' r2://private-pages/page.avif',
  ]) {
    assert.throws(
      () => parsePageStorageRef(rejected, STORAGE_OPTIONS),
      (error) => error instanceof PageStorageError
    );
  }
});

test('storage keys reject aliases, traversal, controls and values above the S3 byte limit', () => {
  assert.equal(normalizePageStorageKey('tome-1/page 1.avif'), 'tome-1/page 1.avif');
  assert.equal(normalizePageStorageKey('a'.repeat(1024)), 'a'.repeat(1024));
  for (const rejected of [
    '/leading-slash.avif',
    'double//slash.avif',
    'dot/./page.avif',
    'parent/../page.avif',
    'windows\\page.avif',
    'control\0page.avif',
    'é'.repeat(513),
  ]) {
    assert.throws(
      () => normalizePageStorageKey(rejected),
      assertStorageError('INVALID_PAGE_KEY', 400)
    );
  }
});

test('legacy URLs require the exact HTTPS origin and preserve root-level object keys', () => {
  const reference = 'https://media.example.test/tome-1/page%203.avif';
  assert.deepEqual(parsePageStorageRef(reference, STORAGE_OPTIONS), {
    bucket: 'legacy-pages',
    key: 'tome-1/page 3.avif',
  });

  for (const rejected of [
    'http://media.example.test/tome-1/page.avif',
    'https://media.example.test.evil/tome-1/page.avif',
    'https://user@media.example.test/tome-1/page.avif',
    'https://media.example.test',
    'https://media.example.test/tome-1/../covers/private.avif',
    'https://media.example.test/tome-1/foo%2Fbar.avif',
    'https://media.example.test/tome-1/page.avif?token=secret',
    'https://media.example.test/tome-1/page.avif#secret',
  ]) {
    assert.throws(
      () => parsePageStorageRef(rejected, STORAGE_OPTIONS),
      (error) => error instanceof PageStorageError
    );
  }
});

test('legacy URLs enforce a configured base-path boundary', () => {
  const options = storageOptions({ legacyPublicUrl: 'https://media.example.test/private-pages/' });
  assert.deepEqual(
    parsePageStorageRef('https://media.example.test/private-pages/tome-1/page.avif', options),
    { bucket: 'legacy-pages', key: 'tome-1/page.avif' }
  );
  for (const rejected of [
    'https://media.example.test/private-pages-evil/page.avif',
    'https://media.example.test/private-pages',
    'https://media.example.test/tome-1/page.avif',
  ]) {
    assert.throws(
      () => parsePageStorageRef(rejected, options),
      (error) => error instanceof PageStorageError
    );
  }
});

test('legacy configured R2 URLs are read through the fixed authenticated bucket', async () => {
  const requests = [];
  const client = {
    async send(command, requestOptions) {
      requests.push({ input: command.input, signal: requestOptions.abortSignal });
      return {
        Body: Readable.from([Uint8Array.from([1, 2, 3])]),
        ContentType: 'image/avif',
        ContentLength: 3,
      };
    },
  };

  const image = await readPageImage('https://media.example.test/tome-1/page.avif', {
    ...STORAGE_OPTIONS,
    client,
  });

  assert.deepEqual(requests[0].input, { Bucket: 'legacy-pages', Key: 'tome-1/page.avif' });
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.deepEqual(image.buffer, Buffer.from([1, 2, 3]));
  assert.equal(image.contentType, 'image/avif');
});

test('non-streaming storage adapters are rejected before unbounded byte-array allocation', async () => {
  let transformed = false;
  let cancelled = false;
  const body = {
    transformToByteArray: async () => {
      transformed = true;
      return Uint8Array.from([1, 2, 3]);
    },
    cancel() { cancelled = true; },
  };
  const client = {
    async send() {
      return { Body: body, ContentType: 'image/webp', ContentLength: 3 };
    },
  };

  await assert.rejects(
    () => openPageImage('r2://private-pages/chapter/page.webp', storageOptions({ client })),
    assertStorageError('UNSUPPORTED_PAGE_STREAM', 502)
  );
  assert.equal(transformed, false);
  assert.equal(cancelled, true);
});

test('ContentLength rejects oversized or malformed objects before their body is consumed', async () => {
  for (const contentLength of [MAX_PAGE_IMAGE_BYTES + 1, -1, '1024']) {
    const body = Readable.from([Buffer.from('must-not-be-read')]);
    const client = {
      async send() {
        return { Body: body, ContentLength: contentLength };
      },
    };

    await assert.rejects(
      () => openPageImage('r2://private-pages/page.avif', storageOptions({ client })),
      (error) => (
        contentLength === MAX_PAGE_IMAGE_BYTES + 1
          ? assertStorageError('PAGE_IMAGE_TOO_LARGE', 413)(error)
          : assertStorageError('INVALID_PAGE_IMAGE_LENGTH', 502)(error)
      )
    );
    assert.equal(body.destroyed, true);
  }
});

test('the streaming byte counter rejects a body that lies about ContentLength', async () => {
  const source = Readable.from([Buffer.alloc(5, 1), Buffer.alloc(5, 2)]);
  const client = {
    async send() {
      return { Body: source, ContentType: 'image/png', ContentLength: 2 };
    },
  };

  await assert.rejects(
    () => readPageImage('r2://private-pages/page.png', storageOptions({
      client,
      maxBytes: 8,
    })),
    assertStorageError('PAGE_IMAGE_TOO_LARGE', 413)
  );
  assert.equal(source.destroyed, true);
});

test('streaming accepts a body exactly at the configured byte ceiling', async () => {
  const client = {
    async send() {
      return {
        Body: Readable.from([Buffer.alloc(3, 1), Buffer.alloc(5, 2)]),
        ContentType: 'image/png',
      };
    },
  };

  const image = await readPageImage('r2://private-pages/page.png', storageOptions({
    client,
    maxBytes: 8,
  }));
  assert.equal(image.buffer.length, 8);
});

test('the storage timeout aborts a pending S3 request through its abort signal', async () => {
  let receivedSignal;
  const client = {
    send(_command, { abortSignal }) {
      receivedSignal = abortSignal;
      return new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    },
  };

  await assert.rejects(
    () => openPageImage('r2://private-pages/page.avif', storageOptions({
      client,
      timeoutMs: 10,
    })),
    assertStorageError('PAGE_IMAGE_TIMEOUT', 504)
  );
  assert.equal(receivedSignal.aborted, true);
});

test('the same timeout remains active while the page body is streaming', async () => {
  const source = new Readable({ read() {} });
  const client = {
    async send() {
      return { Body: source, ContentType: 'image/png' };
    },
  };

  await assert.rejects(
    () => readPageImage('r2://private-pages/page.png', storageOptions({
      client,
      timeoutMs: 10,
    })),
    assertStorageError('PAGE_IMAGE_TIMEOUT', 504)
  );
  assert.equal(source.destroyed, true);
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
  for (const reference of [
    'https://attacker.example/page.png',
    'https://media.example.test.attacker.example/page.png',
    'http://127.0.0.1/page.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/page.png',
  ]) {
    assert.throws(
      () => parsePageStorageRef(reference, STORAGE_OPTIONS),
      /configured R2 storage/
    );
  }
});
