const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');

const { createPageStorageRef, getPrivatePagesBucketName } = require('../utils/pageStorage');
const { ChapterImportError } = require('./chapterImportArchive');

function createR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
}

function toNodeReadable(body) {
  if (!body) throw new ChapterImportError('EMPTY_STORAGE_OBJECT', 'Le stockage a renvoyé un objet vide.', { retryable: true });
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (body[Symbol.asyncIterator]) return Readable.from(body);
  throw new ChapterImportError('UNSUPPORTED_STORAGE_STREAM', 'Le flux renvoyé par le stockage est invalide.', { retryable: true });
}

function getChapterImportPrefix(jobId) {
  return `_chapter-imports/${jobId}/`;
}

function getChapterPageKey(jobId, pageNumber, extension) {
  return `${getChapterImportPrefix(jobId)}pages/${String(pageNumber).padStart(6, '0')}.${extension}`;
}

function createChapterImportStorage({
  client = createR2Client(),
  bucket = getPrivatePagesBucketName(),
} = {}) {
  if (!bucket) throw new Error('A private page bucket is required for chapter imports');

  async function uploadSource(filePath, job) {
    const stats = await fs.promises.stat(filePath);
    await client.send(new PutObjectCommand({
      Bucket: job.archive_bucket || bucket,
      Key: job.archive_key,
      Body: fs.createReadStream(filePath),
      ContentLength: stats.size,
      ContentType: 'application/zip',
      CacheControl: 'private, no-store',
      Metadata: {
        'import-job-id': job.id,
        sha256: job.archive_sha256,
      },
    }));
  }

  async function downloadSource(job, destination) {
    const response = await client.send(new GetObjectCommand({
      Bucket: job.archive_bucket,
      Key: job.archive_key,
    }));
    let bytes = 0;
    const limit = Number(job.archive_bytes);
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (!Number.isSafeInteger(limit) || bytes > limit) {
          callback(new ChapterImportError('SOURCE_SIZE_MISMATCH', 'L’archive stockée dépasse la taille annoncée.'));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(toNodeReadable(response.Body), limiter, fs.createWriteStream(destination, { flags: 'wx' }));
    if (bytes !== limit) {
      throw new ChapterImportError('SOURCE_SIZE_MISMATCH', 'La taille de l’archive stockée ne correspond pas à la réception.');
    }
    return bytes;
  }

  async function pageAlreadyUploaded(job, pageNumber, image, sha256) {
    const key = getChapterPageKey(job.id, pageNumber, image.extension);
    try {
      const response = await client.send(new HeadObjectCommand({ Bucket: job.archive_bucket, Key: key }));
      return {
        exists: true,
        matches: response.Metadata?.sha256 === sha256
          && response.Metadata?.['import-job-id'] === job.id
          && response.Metadata?.['page-number'] === String(pageNumber),
        key,
      };
    } catch (error) {
      if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
        return { exists: false, matches: false, key };
      }
      throw error;
    }
  }

  async function uploadPage(filePath, job, pageNumber, image, sha256) {
    const stats = await fs.promises.stat(filePath);
    const existing = await pageAlreadyUploaded(job, pageNumber, image, sha256);
    if (existing.exists && !existing.matches) {
      throw new ChapterImportError(
        'STORED_PAGE_MISMATCH',
        'Une page déjà stockée pour cet import ne correspond pas au fichier extrait.'
      );
    }
    if (!existing.exists) {
      await client.send(new PutObjectCommand({
        Bucket: job.archive_bucket,
        Key: existing.key,
        Body: fs.createReadStream(filePath),
        ContentLength: stats.size,
        ContentType: image.contentType,
        CacheControl: 'private, no-store',
        Metadata: {
          'import-job-id': job.id,
          'page-number': String(pageNumber),
          sha256,
        },
      }));
    }
    return {
      key: existing.key,
      storageRef: createPageStorageRef(job.archive_bucket, existing.key),
      reused: existing.matches,
    };
  }

  async function deleteSource(job) {
    await client.send(new DeleteObjectCommand({ Bucket: job.archive_bucket, Key: job.archive_key }));
  }

  async function deleteImportPrefix(job) {
    let continuationToken;
    do {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: job.archive_bucket,
        Prefix: getChapterImportPrefix(job.id),
        ContinuationToken: continuationToken,
      }));
      const objects = (response.Contents || []).map((object) => ({ Key: object.Key })).filter((object) => object.Key);
      if (objects.length > 0) {
        const deletion = await client.send(new DeleteObjectsCommand({
          Bucket: job.archive_bucket,
          Delete: { Objects: objects, Quiet: true },
        }));
        if (deletion.Errors?.length) {
          throw new ChapterImportError(
            'IMPORT_CLEANUP_INCOMPLETE',
            `Le stockage n’a pas supprimé ${deletion.Errors.length} objet(s) de l’import.`,
            { retryable: true }
          );
        }
      }
      if (response.IsTruncated && !response.NextContinuationToken) {
        throw new ChapterImportError(
          'IMPORT_CLEANUP_PAGINATION_ERROR',
          'Le stockage a interrompu le listing sans fournir de jeton de reprise.',
          { retryable: true }
        );
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  return {
    bucket,
    deleteImportPrefix,
    deleteSource,
    downloadSource,
    pageAlreadyUploaded,
    uploadPage,
    uploadSource,
  };
}

module.exports = {
  createChapterImportStorage,
  createR2Client,
  getChapterImportPrefix,
  getChapterPageKey,
};
