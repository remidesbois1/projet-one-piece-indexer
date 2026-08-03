const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');

const inputLimits = require('@poneglyph/shared/input-limits.json');
const { ChapterImportError, hashFile, inspectChapterArchive } = require('../services/chapterImportArchive');
const { createChapterImportRepository, isMissingChapterImportSchema } = require('../services/chapterImportRepository');
const { createChapterImportStorage } = require('../services/chapterImportStorage');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const uploadDirectory = path.join(os.tmpdir(), 'poneglyph-chapter-uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const archiveUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      callback(null, uploadDirectory);
    },
    filename(req, file, callback) {
      callback(null, `chapter-${crypto.randomUUID()}.cbz`);
    },
  }),
  limits: {
    fileSize: inputLimits.chapterArchiveBytes,
    files: 1,
    fields: 3,
    parts: 4,
    fieldNameSize: 100,
    fieldSize: 2_000,
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    if (extension !== '.cbz' && extension !== '.zip') {
      callback(new ChapterImportError('UNSUPPORTED_ARCHIVE_EXTENSION', 'Seuls les fichiers .cbz et .zip sont acceptés.', {
        statusCode: 415,
      }));
      return;
    }
    callback(null, true);
  },
});

function chapterArchiveUploadMiddleware(req, res, next) {
  archiveUpload.single('cbzFile')(req, res, (error) => {
    if (!error) return next();
    if (req.file?.path) fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'L’archive dépasse la taille maximale autorisée.' });
    }
    const status = error.statusCode || (error instanceof multer.MulterError ? 400 : 415);
    return res.status(status).json({ error: error.message || 'Upload CBZ invalide.' });
  });
}

function buildRequestHash({ tomeId, chapterNumber, chapterTitle, archiveSha256 }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    tomeId,
    chapterNumber,
    chapterTitle: chapterTitle.trim(),
    archiveSha256,
  })).digest('hex');
}

function getIdempotencyKey(req, requestHash) {
  const supplied = req.get('Idempotency-Key');
  if (supplied === undefined) return `derived:${requestHash}`;
  if (!IDEMPOTENCY_KEY_PATTERN.test(supplied)) {
    throw new ChapterImportError('INVALID_IDEMPOTENCY_KEY', 'La clé d’idempotence doit contenir 8 à 128 caractères sûrs.', {
      statusCode: 400,
    });
  }
  return supplied;
}

function serializeChapterImportJob(job) {
  if (!job) return null;
  const total = Number(job.total_pages) || 0;
  const processed = Number(job.processed_pages) || 0;
  return {
    id: job.id,
    status: job.status,
    tome_id: job.tome_id,
    chapter_number: job.chapter_number,
    chapter_title: job.chapter_title,
    chapter_id: job.chapter_id,
    progress: {
      processed,
      total,
      percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    },
    attempt_count: job.attempt_count,
    error: job.status === 'failed'
      ? { code: job.error_code || 'IMPORT_FAILED', message: job.error_message || 'Échec de l’import.' }
      : null,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

function mapChapterImportError(error) {
  if (error instanceof ChapterImportError) {
    return { status: error.statusCode, message: error.message };
  }
  if (isMissingChapterImportSchema(error)) {
    return { status: 503, message: 'Le schéma des imports de chapitres n’est pas installé.' };
  }
  if (error?.code === 'P0002') return { status: 404, message: error.message || 'Ressource introuvable.' };
  if (error?.code === '42501') return { status: 403, message: error.message || 'Import refusé.' };
  if (['22000', '23505'].includes(error?.code)) return { status: 409, message: error.message || 'Import en conflit.' };
  if (['22023', '23514'].includes(error?.code)) return { status: 422, message: error.message || 'Import invalide.' };
  return { status: 500, message: 'Échec du traitement de l’import.' };
}

function createChapterImportHandlers({
  repository = createChapterImportRepository(),
  storage = createChapterImportStorage(),
  inspectArchive = inspectChapterArchive,
  calculateHash = hashFile,
} = {}) {
  async function create(req, res) {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Un fichier CBZ ou ZIP est requis.' });

    try {
      const { tome_id: tomeId, numero: chapterNumber, titre: chapterTitle } = req.validated.body;
      const [archive, archiveSha256] = await Promise.all([
        inspectArchive(file.path),
        calculateHash(file.path),
      ]);
      const requestHash = buildRequestHash({ tomeId, chapterNumber, chapterTitle, archiveSha256 });
      const idempotencyKey = getIdempotencyKey(req, requestHash);

      let job = await repository.begin({
        idempotencyKey,
        requestHash,
        actorId: req.user.id,
        tomeId,
        chapterNumber,
        chapterTitle,
        archiveBucket: storage.bucket,
        archiveSha256,
        archiveBytes: archive.archiveBytes,
        totalEntries: archive.totalEntries,
        totalPages: archive.totalPages,
      });

      if (job.status === 'receiving') {
        await storage.uploadSource(file.path, job);
        job = await repository.queue(job.id, req.user.id);
      }

      const statusCode = job.status === 'completed' ? 200 : 202;
      return res.status(statusCode).json({
        job: serializeChapterImportJob(job),
        status_url: `/admin/chapter-imports/${job.id}`,
        poll_after_ms: 1500,
      });
    } catch (error) {
      const response = mapChapterImportError(error);
      if (response.status >= 500) {
        const errorCode = String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 80);
        console.error(`[ChapterImport] Reception failed (${errorCode || 'UNKNOWN'}).`);
      }
      return res.status(response.status).json({ error: response.message });
    } finally {
      await fs.promises.rm(file.path, { force: true }).catch(() => {});
    }
  }

  async function get(req, res) {
    if (!UUID_PATTERN.test(req.params.id || '')) {
      return res.status(400).json({ error: 'Identifiant d’import invalide.' });
    }
    try {
      const job = await repository.get(req.params.id, req.user.id);
      if (!job) return res.status(404).json({ error: 'Import introuvable.' });
      return res.json({
        job: serializeChapterImportJob(job),
        status_url: `/admin/chapter-imports/${job.id}`,
        poll_after_ms: 1500,
      });
    } catch (error) {
      const response = mapChapterImportError(error);
      return res.status(response.status).json({ error: response.message });
    }
  }

  return { create, get };
}

module.exports = {
  buildRequestHash,
  chapterArchiveUploadMiddleware,
  createChapterImportHandlers,
  getIdempotencyKey,
  mapChapterImportError,
  serializeChapterImportJob,
};
