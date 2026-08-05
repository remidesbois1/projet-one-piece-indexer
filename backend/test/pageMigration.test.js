const assert = require('node:assert/strict');
const test = require('node:test');

const inputLimits = require('@poneglyph/shared/input-limits.json');
const {
  createMigrationMetadata,
  migratePage,
  validateMigrationObject,
} = require('../scripts/migrate_pages_to_private_r2');

test('the private-page migration accepts only canonical references in its target bucket', async () => {
  assert.equal(
    await migratePage({ id: 1, url_image: 'r2://private-pages/tome-1/page.avif' }, 'private-pages'),
    'already-private'
  );

  for (const reference of [
    'r2://other-bucket/tome-1/page.avif',
    'r2://private-pages/tome-1/../page.avif',
    'r2://private-pages/tome-1/page%2eavif',
    'r2://user@private-pages/tome-1/page.avif',
  ]) {
    await assert.rejects(
      () => migratePage({ id: 1, url_image: reference }, 'private-pages'),
      (error) => ['PAGE_BUCKET_NOT_ALLOWED', 'INVALID_PAGE_REFERENCE'].includes(error.code)
    );
  }
});

test('migration object sizes are integral, non-empty and bounded by the runtime reader', () => {
  assert.equal(
    validateMigrationObject({ ContentLength: inputLimits.pageImageBytes }),
    inputLimits.pageImageBytes
  );
  for (const [contentLength, code] of [
    [inputLimits.pageImageBytes + 1, 'PAGE_IMAGE_TOO_LARGE'],
    [0, 'INVALID_PAGE_IMAGE_LENGTH'],
    [-1, 'INVALID_PAGE_IMAGE_LENGTH'],
    ['10', 'INVALID_PAGE_IMAGE_LENGTH'],
  ]) {
    assert.throws(
      () => validateMigrationObject({ ContentLength: contentLength }),
      (error) => error.code === code
    );
  }
});

test('migration dry-runs inspect legacy object size before reporting a plan', async () => {
  const requests = [];
  const storageClient = {
    async send(command) {
      requests.push(command);
      return { ContentLength: inputLimits.pageImageBytes + 1 };
    },
  };
  await assert.rejects(
    () => migratePage(
      { id: 2, url_image: 'https://media.example.test/tome-1/page.avif' },
      'private-pages',
      {
        storageClient,
        apply: false,
        legacyPublicUrl: 'https://media.example.test',
        legacyBucket: 'legacy-pages',
        log() {},
      }
    ),
    (error) => error.code === 'PAGE_IMAGE_TOO_LARGE'
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].constructor.name, 'HeadObjectCommand');
});

test('migration copies with source preconditions and a retryable cleanup marker', async () => {
  const requests = [];
  const storageClient = {
    async send(command) {
      requests.push(command);
      if (command.constructor.name === 'HeadObjectCommand' && requests.length === 1) {
        return { ContentLength: 123, ContentType: 'image/jpeg', ETag: '"source-etag"' };
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentLength: 123,
          Metadata: createMigrationMetadata({ bucket: 'legacy-pages', key: 'tome-1/page.avif' }),
        };
      }
      return {};
    },
  };
  const database = {
    from(table) {
      assert.equal(table, 'pages');
      return {
        update(value) {
          assert.match(value.url_image, /^r2:\/\/private-pages\//);
          return {
            async eq(column, id) {
              assert.equal(column, 'id');
              assert.equal(id, 3);
              return { error: null };
            },
          };
        },
      };
    },
  };

  assert.equal(
    await migratePage(
      { id: 3, url_image: 'https://media.example.test/tome-1/page.avif' },
      'private-pages',
      {
        storageClient,
        database,
        apply: true,
        legacyPublicUrl: 'https://media.example.test',
        legacyBucket: 'legacy-pages',
      }
    ),
    'migrated'
  );
  const copy = requests.find((command) => command.constructor.name === 'CopyObjectCommand');
  assert.equal(copy.input.CopySourceIfMatch, '"source-etag"');
  assert.deepEqual(
    copy.input.Metadata,
    createMigrationMetadata({ bucket: 'legacy-pages', key: 'tome-1/page.avif' })
  );
});

test('rerunning cleanup for a marked private page idempotently deletes its legacy source', async () => {
  const key = 'tome-1/page.avif';
  const requests = [];
  const storageClient = {
    async send(command) {
      requests.push(command);
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentLength: 123,
          Metadata: createMigrationMetadata({ bucket: 'legacy-pages', key }),
        };
      }
      return {};
    },
  };
  assert.equal(
    await migratePage(
      { id: 4, url_image: `r2://private-pages/${key}` },
      'private-pages',
      {
        storageClient,
        apply: true,
        deleteSource: true,
        legacyBucket: 'legacy-pages',
      }
    ),
    'purged-legacy'
  );
  const deletion = requests.find((command) => command.constructor.name === 'DeleteObjectCommand');
  assert.deepEqual(deletion.input, { Bucket: 'legacy-pages', Key: key });
});
