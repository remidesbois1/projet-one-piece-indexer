const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ChapterImportError } = require('../src/services/chapterImportArchive');
const { createChapterImportHandlers } = require('../src/routes/chapterImportRoutes');

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function withUploadFile(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chapter-route-test-'));
  const filePath = path.join(directory, 'chapter.cbz');
  await fs.promises.writeFile(filePath, 'fixture');
  try {
    return await callback(filePath);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

function createRequest(filePath) {
  return {
    file: { path: filePath },
    user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    validated: { body: { tome_id: 12, numero: 34, titre: 'A chapter' } },
    get(name) {
      return name === 'Idempotency-Key' ? 'client-key-1234' : undefined;
    },
  };
}

test('chapter reception stages the source before queueing and returns an opaque job', async () => {
  await withUploadFile(async (filePath) => {
    const events = [];
    const receiving = {
      id: JOB_ID,
      status: 'receiving',
      archive_bucket: 'private-pages',
      archive_key: `_chapter-imports/${JOB_ID}/source.cbz`,
      archive_sha256: 'a'.repeat(64),
      total_pages: 2,
      processed_pages: 0,
    };
    const repository = {
      async begin(input) {
        events.push(['begin', input]);
        return receiving;
      },
      async queue(id, actorId) {
        events.push(['queue', id, actorId]);
        return { ...receiving, status: 'queued' };
      },
    };
    const storage = {
      bucket: 'private-pages',
      async uploadSource(source, job) {
        assert.equal(await fs.promises.readFile(source, 'utf8'), 'fixture');
        events.push(['upload', job.id]);
      },
    };
    const handlers = createChapterImportHandlers({
      repository,
      storage,
      inspectArchive: async () => ({ archiveBytes: 7, totalEntries: 2, totalPages: 2 }),
      calculateHash: async () => 'a'.repeat(64),
    });
    const response = createResponse();

    await handlers.create(createRequest(filePath), response);

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.job.status, 'queued');
    assert.equal(response.body.status_url, `/admin/chapter-imports/${JOB_ID}`);
    assert.equal('archive_bucket' in response.body.job, false);
    assert.deepEqual(events.map(([event]) => event), ['begin', 'upload', 'queue']);
    assert.equal(events[0][1].idempotencyKey, 'client-key-1234');
    assert.equal(fs.existsSync(filePath), false);
  });
});

test('completed idempotent replays do not upload or enqueue the archive again', async () => {
  await withUploadFile(async (filePath) => {
    let writes = 0;
    const completed = {
      id: JOB_ID,
      status: 'completed',
      total_pages: 2,
      processed_pages: 2,
      chapter_id: 99,
    };
    const handlers = createChapterImportHandlers({
      repository: {
        begin: async () => completed,
        queue: async () => { throw new Error('must not queue'); },
      },
      storage: {
        bucket: 'private-pages',
        uploadSource: async () => { writes += 1; },
      },
      inspectArchive: async () => ({ archiveBytes: 7, totalEntries: 2, totalPages: 2 }),
      calculateHash: async () => 'a'.repeat(64),
    });
    const response = createResponse();

    await handlers.create(createRequest(filePath), response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.job.chapter_id, 99);
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(filePath), false);
  });
});

test('archive validation errors return their bounded status and always remove the upload', async () => {
  await withUploadFile(async (filePath) => {
    const handlers = createChapterImportHandlers({
      repository: {},
      storage: { bucket: 'private-pages' },
      inspectArchive: async () => {
        throw new ChapterImportError('INVALID_ZIP_SIGNATURE', 'Archive forgée.', { statusCode: 415 });
      },
      calculateHash: async () => 'a'.repeat(64),
    });
    const response = createResponse();

    await handlers.create(createRequest(filePath), response);

    assert.equal(response.statusCode, 415);
    assert.deepEqual(response.body, { error: 'Archive forgée.' });
    assert.equal(fs.existsSync(filePath), false);
  });
});
