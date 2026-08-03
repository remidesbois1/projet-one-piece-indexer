const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ChapterImportError,
  DEFAULT_LIMITS,
  hashFile,
  inspectChapterArchive,
  inspectImageFile,
  streamArchiveEntryToFile,
} = require('../services/chapterImportArchive');
const { createChapterImportRepository, isMissingChapterImportSchema } = require('../services/chapterImportRepository');
const { createChapterImportStorage } = require('../services/chapterImportStorage');

async function removeTemporaryPath(target, { recursive = false } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function normalizeFailure(error) {
  if (error instanceof ChapterImportError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const code = String(error?.code || error?.name || 'IMPORT_ERROR').slice(0, 100);
  const permanentDatabaseCodes = new Set(['22000', '22023', '23505', '23514', '42501', '55000']);
  return {
    code,
    message: String(error?.message || 'Erreur inattendue pendant l’import.').slice(0, 2000),
    retryable: !permanentDatabaseCodes.has(code),
  };
}

function restoreCheckpoint(job, limits) {
  if (!Array.isArray(job.manifest)) return [];
  if (job.manifest.length > Number(job.total_pages)) {
    throw new ChapterImportError('INVALID_IMPORT_CHECKPOINT', 'La progression enregistrée dépasse le nombre de pages attendu.');
  }

  const prefix = `r2://${job.archive_bucket}/_chapter-imports/${job.id}/pages/`;
  let expandedBytes = 0;
  const manifest = job.manifest.map((page, index) => {
    const byteSize = Number(page?.byte_size);
    if (
      Number(page?.numero_page) !== index + 1
      || typeof page?.url_image !== 'string'
      || !page.url_image.startsWith(prefix)
      || !/^[0-9a-f]{64}$/.test(page?.sha256 || '')
      || !Number.isSafeInteger(byteSize)
      || byteSize < 1
      || byteSize > limits.entryBytes
    ) {
      throw new ChapterImportError('INVALID_IMPORT_CHECKPOINT', 'La progression enregistrée est incohérente.');
    }
    expandedBytes += byteSize;
    return { ...page, byte_size: byteSize };
  });
  if (expandedBytes > limits.expandedBytes) {
    throw new ChapterImportError('ARCHIVE_EXPANDED_TOO_LARGE', 'La progression dépasse la taille extraite autorisée.');
  }
  return manifest;
}

async function processChapterImportJob(job, {
  repository,
  storage,
  workerId,
  leaseSeconds = 120,
  limits = DEFAULT_LIMITS,
} = {}) {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'poneglyph-chapter-import-'));
  const archivePath = path.join(tempDirectory, 'source.cbz');
  const manifest = restoreCheckpoint(job, limits);
  let heartbeatError = null;
  const heartbeat = setInterval(() => {
    repository.heartbeat(job.id, workerId, leaseSeconds).catch((error) => {
      heartbeatError = error;
    });
  }, Math.max(10_000, Math.floor((leaseSeconds * 1000) / 3)));
  heartbeat.unref?.();

  try {
    await storage.downloadSource(job, archivePath);
    const archiveHash = await hashFile(archivePath);
    if (archiveHash !== job.archive_sha256) {
      throw new ChapterImportError('SOURCE_HASH_MISMATCH', 'L’archive stockée ne correspond pas au fichier reçu.');
    }

    const archive = await inspectChapterArchive(archivePath, { limits });
    if (heartbeatError) throw heartbeatError;
    if (archive.totalEntries !== job.total_entries || archive.totalPages !== job.total_pages) {
      throw new ChapterImportError('ARCHIVE_MANIFEST_MISMATCH', 'Le contenu de l’archive a changé depuis sa réception.');
    }

    let expandedImageBytes = manifest.reduce((total, page) => total + page.byte_size, 0);
    for (let index = manifest.length; index < archive.imageEntries.length; index += 1) {
      if (heartbeatError) throw heartbeatError;
      const pageNumber = index + 1;
      const extractedPath = path.join(tempDirectory, `page-${String(pageNumber).padStart(6, '0')}.bin`);
      const extracted = await streamArchiveEntryToFile(archive.imageEntries[index].entry, extractedPath, {
        maxBytes: limits.entryBytes,
      });
      expandedImageBytes += extracted.bytes;
      if (expandedImageBytes > limits.expandedBytes) {
        throw new ChapterImportError('ARCHIVE_EXPANDED_TOO_LARGE', 'La taille réellement extraite dépasse la limite autorisée.');
      }

      const image = await inspectImageFile(extractedPath, { maxPixels: limits.imagePixels });
      const uploaded = await storage.uploadPage(extractedPath, job, pageNumber, image, extracted.sha256);
      manifest.push({
        numero_page: pageNumber,
        url_image: uploaded.storageRef,
        sha256: extracted.sha256,
        width: image.width,
        height: image.height,
        content_type: image.contentType,
        byte_size: extracted.bytes,
      });
      await repository.updateProgress(job.id, workerId, manifest, leaseSeconds);
      await removeTemporaryPath(extractedPath);
    }

    const completed = await repository.finalize(job.id, workerId, manifest);
    try {
      await storage.deleteSource(job);
      await repository.markSourceDeleted(job.id);
    } catch (cleanupError) {
      console.warn('[ChapterImportWorker] Source cleanup deferred:', cleanupError.message);
    }
    return completed;
  } finally {
    clearInterval(heartbeat);
    await removeTemporaryPath(tempDirectory, { recursive: true });
  }
}

function createChapterImportWorker({
  repository = createChapterImportRepository(),
  storage = createChapterImportStorage(),
  workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`,
  leaseSeconds = 120,
  limits = DEFAULT_LIMITS,
} = {}) {
  async function cleanupFinishedJobs() {
    await repository.reapStale(25);
    const jobs = await repository.listCleanupJobs(5);
    for (const job of jobs) {
      try {
        if (job.status === 'completed') await storage.deleteSource(job);
        else await storage.deleteImportPrefix(job);
        await repository.markSourceDeleted(job.id);
      } catch (error) {
        console.warn(`[ChapterImportWorker] Cleanup deferred for ${job.id}:`, error.message);
      }
    }
  }

  async function runOnce() {
    await cleanupFinishedJobs();
    const job = await repository.claim(workerId, leaseSeconds);
    if (!job) return null;

    try {
      return await processChapterImportJob(job, { repository, storage, workerId, leaseSeconds, limits });
    } catch (error) {
      const failure = normalizeFailure(error);
      if (failure.retryable) {
        try {
          const current = await repository.get(job.id, job.created_by);
          if (current?.status === 'completed') {
            try {
              await storage.deleteSource(job);
              await repository.markSourceDeleted(job.id);
            } catch (cleanupError) {
              console.warn(`[ChapterImportWorker] Completed import cleanup deferred for ${job.id}:`, cleanupError.message);
            }
            return current;
          }
        } catch {
          // The lease/failure path below remains authoritative when status cannot be re-read.
        }
      }
      let failedJob;
      try {
        failedJob = await repository.fail(job.id, workerId, failure);
      } catch (reportError) {
        console.error(`[ChapterImportWorker] Failed to persist failure for ${job.id}:`, reportError);
        throw error;
      }
      if (failedJob?.status === 'failed') {
        try {
          await storage.deleteImportPrefix(job);
          await repository.markSourceDeleted(job.id);
        } catch (cleanupError) {
          console.warn(`[ChapterImportWorker] Failed import cleanup deferred for ${job.id}:`, cleanupError.message);
        }
      }
      return failedJob;
    }
  }

  return { cleanupFinishedJobs, runOnce, workerId };
}

function startChapterImportWorker({ pollIntervalMs = 2_000, ...options } = {}) {
  const worker = createChapterImportWorker(options);
  let running = false;
  let stopped = false;
  let missingSchemaReported = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await worker.runOnce();
      missingSchemaReported = false;
    } catch (error) {
      if (isMissingChapterImportSchema(error)) {
        if (!missingSchemaReported) {
          console.warn('[ChapterImportWorker] Import schema is not installed; worker is waiting for the migration.');
          missingSchemaReported = true;
        }
      } else {
        console.error('[ChapterImportWorker] Poll failed:', error);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, Math.max(1_000, pollIntervalMs));
  timer.unref?.();
  setImmediate(tick);
  return {
    ...worker,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = {
  createChapterImportWorker,
  normalizeFailure,
  processChapterImportJob,
  removeTemporaryPath,
  restoreCheckpoint,
  startChapterImportWorker,
};
