const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const {
  ChapterImportError,
  hashFile,
  inspectChapterArchive,
  inspectImageFile,
} = require('../src/services/chapterImportArchive');
const {
  createChapterImportWorker,
  processChapterImportJob,
  restoreCheckpoint,
} = require('../src/jobs/chapterImportWorker');
const {
  buildRequestHash,
  getIdempotencyKey,
  mapChapterImportError,
  serializeChapterImportJob,
} = require('../src/routes/chapterImportRoutes');

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

async function withTempDirectory(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'poneglyph-import-test-'));
  try {
    return await callback(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test('archive inspection validates ZIP structure and sorts page names naturally', async () => {
  await withTempDirectory(async (directory) => {
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#fff' },
    }).jpeg().toBuffer();
    const archivePath = path.join(directory, 'chapter.cbz');
    await fs.promises.writeFile(archivePath, createStoredZip([
      { name: 'pages/10.jpg', data: image },
      { name: 'pages/2.jpg', data: image },
      { name: 'metadata.txt', data: 'ignored' },
    ]));

    const inspected = await inspectChapterArchive(archivePath);
    assert.equal(inspected.totalEntries, 3);
    assert.equal(inspected.totalPages, 2);
    assert.deepEqual(inspected.imageEntries.map((entry) => entry.path), ['pages/2.jpg', 'pages/10.jpg']);
  });
});

test('archive inspection rejects forged files, traversal, symlinks and entry limits', async () => {
  await withTempDirectory(async (directory) => {
    const fake = path.join(directory, 'fake.cbz');
    await fs.promises.writeFile(fake, 'not a zip');
    await assert.rejects(() => inspectChapterArchive(fake), { code: 'INVALID_ZIP_SIGNATURE', statusCode: 415 });

    const traversal = path.join(directory, 'traversal.cbz');
    await fs.promises.writeFile(traversal, createStoredZip([{ name: '../escape.jpg', data: 'x' }]));
    await assert.rejects(() => inspectChapterArchive(traversal), { code: 'UNSAFE_ARCHIVE_PATH' });

    const symlink = path.join(directory, 'symlink.cbz');
    await fs.promises.writeFile(symlink, createStoredZip([{
      name: 'page.jpg',
      data: 'target',
      externalAttributes: (0o120777 << 16) >>> 0,
    }]));
    await assert.rejects(() => inspectChapterArchive(symlink), { code: 'ARCHIVE_SYMLINK' });

    const tooMany = path.join(directory, 'many.cbz');
    await fs.promises.writeFile(tooMany, createStoredZip([
      { name: '1.jpg', data: 'x' },
      { name: '2.jpg', data: 'x' },
    ]));
    await assert.rejects(() => inspectChapterArchive(tooMany, { limits: { entries: 1 } }), { code: 'ARCHIVE_ENTRY_LIMIT' });
  });
});

test('real image validation rejects extension-only payloads and pixel bombs', async () => {
  await withTempDirectory(async (directory) => {
    const textPath = path.join(directory, 'fake.jpg');
    await fs.promises.writeFile(textPath, 'plain text');
    await assert.rejects(() => inspectImageFile(textPath), { code: 'INVALID_IMAGE' });

    const oversizedSvg = path.join(directory, 'oversized.svg');
    await fs.promises.writeFile(oversizedSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"></svg>');
    await assert.rejects(() => inspectImageFile(oversizedSvg, { maxPixels: 100 }), (error) => (
      error.code === 'INVALID_IMAGE' || error.code === 'UNSUPPORTED_IMAGE'
    ));
  });
});

test('real image validation releases file-backed images after inspection', async () => {
  await withTempDirectory(async (directory) => {
    const imagePath = path.join(directory, 'temporary.webp');
    const image = await sharp({
      create: { width: 7, height: 7, channels: 3, background: '#0f0' },
    }).webp().toBuffer();
    await fs.promises.writeFile(imagePath, image);

    await inspectImageFile(imagePath);
    await fs.promises.rm(imagePath);
    assert.equal(fs.existsSync(imagePath), false);
  });
});

test('worker streams pages, checkpoints progress and finalizes only after every upload', async () => {
  await withTempDirectory(async (directory) => {
    const first = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#f00' } }).png().toBuffer();
    const second = await sharp({ create: { width: 7, height: 7, channels: 3, background: '#0f0' } }).webp().toBuffer();
    const sourcePath = path.join(directory, 'source.cbz');
    await fs.promises.writeFile(sourcePath, createStoredZip([
      { name: '2.webp', data: second },
      { name: '1.png', data: first },
    ]));
    const sourceHash = await hashFile(sourcePath);
    const progress = [];
    const uploads = [];
    const job = {
      id: '11111111-1111-4111-8111-111111111111',
      archive_bucket: 'private-pages',
      archive_key: '_chapter-imports/11111111-1111-4111-8111-111111111111/source.cbz',
      archive_bytes: (await fs.promises.stat(sourcePath)).size,
      archive_sha256: sourceHash,
      total_entries: 2,
      total_pages: 2,
    };
    const repository = {
      heartbeat: async () => {},
      updateProgress: async (id, worker, manifest) => progress.push(structuredClone(manifest)),
      finalize: async (id, worker, manifest) => ({ status: 'completed', manifest }),
      markSourceDeleted: async () => {},
    };
    const storage = {
      downloadSource: async (current, destination) => fs.promises.copyFile(sourcePath, destination),
      uploadPage: async (filePath, current, pageNumber, image, sha256) => {
        uploads.push({ pageNumber, image, sha256, bytes: (await fs.promises.stat(filePath)).size });
        return { storageRef: `r2://private-pages/_chapter-imports/${current.id}/pages/${pageNumber}.${image.extension}` };
      },
      deleteSource: async () => {},
    };

    const completed = await processChapterImportJob(job, {
      repository,
      storage,
      workerId: 'test-worker',
      leaseSeconds: 60,
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(uploads.map((upload) => upload.pageNumber), [1, 2]);
    assert.deepEqual(progress.map((manifest) => manifest.length), [1, 2]);
    assert.equal(completed.manifest.length, 2);
  });
});

test('worker records a permanent failure without publishing a partial chapter', async () => {
  const job = { id: 'job-1', created_by: 'admin-1', status: 'processing' };
  const events = [];
  const repository = {
    reapStale: async () => 0,
    listCleanupJobs: async () => [],
    claim: async () => job,
    get: async () => job,
    fail: async (id, worker, failure) => {
      events.push({ type: 'failed', failure });
      return { ...job, status: 'failed' };
    },
    markSourceDeleted: async () => events.push({ type: 'cleaned' }),
  };
  const storage = {
    downloadSource: async () => {
      throw new ChapterImportError('INVALID_ZIP', 'archive rejected');
    },
    deleteImportPrefix: async () => events.push({ type: 'prefix-deleted' }),
  };
  const worker = createChapterImportWorker({ repository, storage, workerId: 'worker-1' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'failed');
  assert.equal(events[0].failure.retryable, false);
  assert.deepEqual(events.map((event) => event.type), ['failed', 'prefix-deleted', 'cleaned']);
});

test('worker checkpoints can resume only from a contiguous job-owned manifest', () => {
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    archive_bucket: 'private-pages',
    total_pages: 2,
    manifest: [{
      numero_page: 1,
      url_image: 'r2://private-pages/_chapter-imports/11111111-1111-4111-8111-111111111111/pages/000001.png',
      sha256: 'a'.repeat(64),
      byte_size: 123,
    }],
  };
  assert.equal(restoreCheckpoint(job, {
    entryBytes: 1_000,
    expandedBytes: 2_000,
  }).length, 1);

  assert.throws(() => restoreCheckpoint({
    ...job,
    manifest: [{ ...job.manifest[0], url_image: 'r2://private-pages/another-import/page.png' }],
  }, {
    entryBytes: 1_000,
    expandedBytes: 2_000,
  }), { code: 'INVALID_IMPORT_CHECKPOINT' });
});

test('idempotency and job DTOs do not expose private storage details', () => {
  const fields = { tomeId: 1, chapterNumber: 2, chapterTitle: 'Title', archiveSha256: 'a'.repeat(64) };
  assert.equal(buildRequestHash(fields), buildRequestHash(fields));
  assert.notEqual(buildRequestHash(fields), buildRequestHash({ ...fields, chapterNumber: 3 }));
  assert.equal(getIdempotencyKey({ get: () => undefined }, 'b'.repeat(64)), `derived:${'b'.repeat(64)}`);
  assert.throws(() => getIdempotencyKey({ get: () => 'bad key!' }, 'b'.repeat(64)), { code: 'INVALID_IDEMPOTENCY_KEY' });
  assert.equal(mapChapterImportError({ code: '23505', message: 'duplicate' }).status, 409);

  const dto = serializeChapterImportJob({
    id: crypto.randomUUID(),
    status: 'processing',
    total_pages: 4,
    processed_pages: 2,
    archive_bucket: 'secret',
    archive_key: 'secret-key',
  });
  assert.equal(dto.progress.percent, 50);
  assert.equal('archive_bucket' in dto, false);
  assert.equal('archive_key' in dto, false);
});

test('migration defines a leased queue and atomic finalization contract', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'sql', '2026-08-01_add_resumable_chapter_imports.sql'),
    'utf8'
  );
  assert.match(sql, /create table if not exists public\.chapter_import_jobs/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /create or replace function public\.heartbeat_chapter_import/i);
  assert.match(sql, /create or replace function public\.finalize_chapter_import/i);
  assert.match(sql, /create or replace function public\.reap_stale_chapter_imports/i);
  assert.match(sql, /status = 'receiving' and expires_at < now\(\)/i);
  assert.match(sql, /attempt_count >= max_attempts/i);
  assert.match(sql, /insert into public\.chapitres[\s\S]*insert into public\.pages/i);
  assert.match(sql, /p_pages <> v_job\.manifest/i);
  assert.match(sql, /revoke all on function public\.finalize_chapter_import.*anon, authenticated/i);
});
