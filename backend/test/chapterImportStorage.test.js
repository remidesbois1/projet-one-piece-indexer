const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const { createChapterImportStorage } = require('../src/services/chapterImportStorage');

const JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  archive_bucket: 'private-pages',
  archive_key: '_chapter-imports/11111111-1111-4111-8111-111111111111/source.cbz',
};

async function withTempFile(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chapter-storage-test-'));
  const filePath = path.join(directory, 'page.png');
  await fs.promises.writeFile(filePath, 'image payload');
  try {
    return await callback(filePath);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test('page uploads reuse matching objects and reject conflicting checkpoints', async () => {
  await withTempFile(async (filePath) => {
    const sent = [];
    const matchingClient = {
      async send(command) {
        sent.push(command);
        if (command instanceof HeadObjectCommand) {
          return {
            Metadata: {
              'import-job-id': JOB.id,
              'page-number': '1',
              sha256: 'a'.repeat(64),
            },
          };
        }
        throw new Error('unexpected command');
      },
    };
    const storage = createChapterImportStorage({ client: matchingClient, bucket: JOB.archive_bucket });
    const reused = await storage.uploadPage(
      filePath,
      JOB,
      1,
      { extension: 'png', contentType: 'image/png' },
      'a'.repeat(64)
    );
    assert.equal(reused.reused, true);
    assert.equal(sent.filter((command) => command instanceof PutObjectCommand).length, 0);

    await assert.rejects(
      () => storage.uploadPage(
        filePath,
        JOB,
        1,
        { extension: 'png', contentType: 'image/png' },
        'b'.repeat(64)
      ),
      { code: 'STORED_PAGE_MISMATCH' }
    );
    assert.equal(sent.filter((command) => command instanceof PutObjectCommand).length, 0);
  });
});

test('prefix cleanup paginates and does not accept partial S3 deletions', async () => {
  const listTokens = [];
  let deleteCount = 0;
  const client = {
    async send(command) {
      if (command instanceof ListObjectsV2Command) {
        listTokens.push(command.input.ContinuationToken ?? null);
        if (!command.input.ContinuationToken) {
          return {
            Contents: [{ Key: `${command.input.Prefix}source.cbz` }],
            IsTruncated: true,
            NextContinuationToken: 'next-page',
          };
        }
        return {
          Contents: [{ Key: `${command.input.Prefix}pages/000001.png` }],
          IsTruncated: false,
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        deleteCount += 1;
        return deleteCount === 1 ? {} : { Errors: [{ Key: 'locked', Code: 'AccessDenied' }] };
      }
      throw new Error('unexpected command');
    },
  };
  const storage = createChapterImportStorage({ client, bucket: JOB.archive_bucket });
  await assert.rejects(() => storage.deleteImportPrefix(JOB), { code: 'IMPORT_CLEANUP_INCOMPLETE' });
  assert.deepEqual(listTokens, [null, 'next-page']);
  assert.equal(deleteCount, 2);
});

test('prefix cleanup cannot report success when storage omits a continuation token', async () => {
  const client = {
    async send(command) {
      assert.ok(command instanceof ListObjectsV2Command);
      return { Contents: [], IsTruncated: true };
    },
  };
  const storage = createChapterImportStorage({ client, bucket: JOB.archive_bucket });
  await assert.rejects(
    () => storage.deleteImportPrefix(JOB),
    { code: 'IMPORT_CLEANUP_PAGINATION_ERROR', retryable: true }
  );
});
