const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const sharp = require('sharp');
const unzipper = require('unzipper');

const inputLimits = require('@poneglyph/shared/input-limits.json');

// libvips otherwise caches file-backed inputs. On Windows that cache keeps the
// extracted WebP/AVIF handle open after metadata() has resolved, so the worker
// cannot reliably remove its bounded temporary files. Imports read every
// extracted page only once, therefore retaining file handles provides no value.
sharp.cache({ files: 0 });

const DEFAULT_LIMITS = Object.freeze({
  archiveBytes: inputLimits.chapterArchiveBytes,
  entries: inputLimits.chapterArchiveEntries,
  pages: inputLimits.chapterArchivePages,
  entryBytes: inputLimits.chapterArchiveEntryBytes,
  expandedBytes: inputLimits.chapterArchiveExpandedBytes,
  compressionRatio: inputLimits.chapterArchiveCompressionRatio,
  imagePixels: inputLimits.chapterImagePixels,
});

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const IMAGE_FORMATS = new Map([
  ['jpeg', { extension: 'jpg', contentType: 'image/jpeg' }],
  ['png', { extension: 'png', contentType: 'image/png' }],
  ['webp', { extension: 'webp', contentType: 'image/webp' }],
  ['avif', { extension: 'avif', contentType: 'image/avif' }],
]);
const naturalPathCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

class ChapterImportError extends Error {
  constructor(code, message, { statusCode = 422, retryable = false } = {}) {
    super(message);
    this.name = 'ChapterImportError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function getEntryPath(entry) {
  return String(entry?.path ?? entry?.fileName ?? '').replaceAll('\\', '/');
}

function normalizeArchivePath(entryPath) {
  const value = String(entryPath || '').replaceAll('\\', '/');
  if (!value || value.includes('\0') || value.startsWith('/') || /^[a-z]:\//i.test(value)) {
    throw new ChapterImportError('UNSAFE_ARCHIVE_PATH', 'L’archive contient un chemin absolu ou invalide.');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new ChapterImportError('UNSAFE_ARCHIVE_PATH', 'L’archive contient un chemin sortant du dossier autorisé.');
  }
  return parts.join('/');
}

function getEntrySizes(entry) {
  const compressed = Number(entry?.compressedSize ?? entry?.vars?.compressedSize ?? 0);
  const uncompressed = Number(entry?.uncompressedSize ?? entry?.vars?.uncompressedSize ?? 0);
  if (!Number.isSafeInteger(compressed) || compressed < 0 || !Number.isSafeInteger(uncompressed) || uncompressed < 0) {
    throw new ChapterImportError('INVALID_ZIP_METADATA', 'Les tailles déclarées par l’archive sont invalides.');
  }
  return { compressed, uncompressed };
}

function isEncryptedEntry(entry) {
  const flags = Number(entry?.vars?.flags ?? entry?.flags ?? 0);
  return Boolean(entry?.isEncrypted || (Number.isInteger(flags) && (flags & 0x1) !== 0));
}

function isSymlinkEntry(entry) {
  const attributes = Number(entry?.vars?.externalFileAttributes ?? entry?.externalFileAttributes ?? 0);
  if (!Number.isSafeInteger(attributes) || attributes <= 0) return false;
  const unixMode = (attributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function readFilePrefix(filePath, length) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function assertZipSignature(filePath) {
  const signature = await readFilePrefix(filePath, 4);
  const valid = signature.length === 4
    && signature[0] === 0x50
    && signature[1] === 0x4b
    && (
      (signature[2] === 0x03 && signature[3] === 0x04)
      || (signature[2] === 0x05 && signature[3] === 0x06)
      || (signature[2] === 0x07 && signature[3] === 0x08)
    );
  if (!valid) {
    throw new ChapterImportError('INVALID_ZIP_SIGNATURE', 'Le fichier n’est pas une archive ZIP/CBZ valide.', {
      statusCode: 415,
    });
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }), new Transform({
    transform(chunk, encoding, callback) {
      callback();
    },
  }));
  return hash.digest('hex');
}

async function inspectChapterArchive(filePath, { limits = DEFAULT_LIMITS } = {}) {
  const mergedLimits = { ...DEFAULT_LIMITS, ...limits };
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile() || stats.size < 1) {
    throw new ChapterImportError('EMPTY_ARCHIVE', 'L’archive est vide.');
  }
  if (stats.size > mergedLimits.archiveBytes) {
    throw new ChapterImportError('ARCHIVE_TOO_LARGE', 'L’archive dépasse la taille maximale autorisée.', {
      statusCode: 413,
    });
  }

  await assertZipSignature(filePath);

  let directory;
  try {
    directory = await unzipper.Open.file(filePath);
  } catch {
    throw new ChapterImportError('INVALID_ZIP', 'Impossible de lire la structure de l’archive.');
  }

  const allEntries = directory.files || [];
  if (allEntries.length < 1 || allEntries.length > mergedLimits.entries) {
    throw new ChapterImportError('ARCHIVE_ENTRY_LIMIT', `L’archive doit contenir entre 1 et ${mergedLimits.entries} entrées.`);
  }

  let expandedBytes = 0;
  const imageEntries = [];
  for (const entry of allEntries) {
    const normalizedPath = normalizeArchivePath(getEntryPath(entry));
    if (isEncryptedEntry(entry)) {
      throw new ChapterImportError('ENCRYPTED_ARCHIVE_ENTRY', 'Les archives chiffrées ne sont pas acceptées.');
    }
    if (isSymlinkEntry(entry)) {
      throw new ChapterImportError('ARCHIVE_SYMLINK', 'Les liens symboliques ne sont pas acceptés dans les archives.');
    }

    const isDirectory = entry.type === 'Directory' || normalizedPath.endsWith('/');
    if (isDirectory) continue;

    const { compressed, uncompressed } = getEntrySizes(entry);
    if (uncompressed > mergedLimits.entryBytes) {
      throw new ChapterImportError('ARCHIVE_ENTRY_TOO_LARGE', `L’entrée ${normalizedPath} dépasse la taille autorisée.`);
    }
    expandedBytes += uncompressed;
    if (expandedBytes > mergedLimits.expandedBytes) {
      throw new ChapterImportError('ARCHIVE_EXPANDED_TOO_LARGE', 'La taille décompressée cumulée dépasse la limite autorisée.');
    }
    if (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > mergedLimits.compressionRatio)) {
      throw new ChapterImportError('SUSPICIOUS_COMPRESSION_RATIO', `Le ratio de compression de ${normalizedPath} est anormal.`);
    }

    if (normalizedPath.split('/').includes('__MACOSX')) continue;
    if (IMAGE_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase())) {
      imageEntries.push({ entry, path: normalizedPath, compressedBytes: compressed, declaredBytes: uncompressed });
    }
  }

  if (imageEntries.length < 1) {
    throw new ChapterImportError('ARCHIVE_WITHOUT_IMAGES', 'L’archive ne contient aucune image prise en charge.');
  }
  if (imageEntries.length > mergedLimits.pages) {
    throw new ChapterImportError('ARCHIVE_PAGE_LIMIT', `L’archive dépasse la limite de ${mergedLimits.pages} pages.`);
  }

  imageEntries.sort((left, right) => naturalPathCollator.compare(left.path, right.path));
  return {
    archiveBytes: stats.size,
    totalEntries: allEntries.length,
    totalPages: imageEntries.length,
    declaredExpandedBytes: expandedBytes,
    imageEntries,
  };
}

async function streamArchiveEntryToFile(entry, destination, { maxBytes = DEFAULT_LIMITS.entryBytes } = {}) {
  const source = typeof entry?.stream === 'function' ? entry.stream() : entry;
  if (!source || typeof source.pipe !== 'function') {
    throw new ChapterImportError('UNREADABLE_ARCHIVE_ENTRY', 'Impossible de lire une entrée de l’archive.');
  }

  let bytes = 0;
  const hash = crypto.createHash('sha256');
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new ChapterImportError('ARCHIVE_ENTRY_TOO_LARGE', 'Une entrée dépasse sa taille maximale pendant l’extraction.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(source, limiter, fs.createWriteStream(destination, { flags: 'wx' }));
  return { bytes, sha256: hash.digest('hex') };
}

async function inspectImageFile(filePath, { maxPixels = DEFAULT_LIMITS.imagePixels } = {}) {
  let metadata;
  let image;
  try {
    image = sharp(filePath, { limitInputPixels: maxPixels, sequentialRead: true });
    metadata = await image.metadata();
  } catch {
    throw new ChapterImportError('INVALID_IMAGE', 'Une page déclarée comme image est corrompue ou trop grande.');
  } finally {
    image?.destroy();
  }

  const imageType = IMAGE_FORMATS.get(metadata.format);
  const pixels = Number(metadata.width) * Number(metadata.height);
  if (!imageType || !Number.isSafeInteger(pixels) || pixels < 1 || pixels > maxPixels) {
    throw new ChapterImportError('UNSUPPORTED_IMAGE', 'Seules les images JPEG, PNG, WebP et AVIF bornées sont acceptées.');
  }

  return {
    format: metadata.format,
    extension: imageType.extension,
    contentType: imageType.contentType,
    width: metadata.width,
    height: metadata.height,
    pixels,
  };
}

module.exports = {
  ChapterImportError,
  DEFAULT_LIMITS,
  assertZipSignature,
  hashFile,
  inspectChapterArchive,
  inspectImageFile,
  normalizeArchivePath,
  streamArchiveEntryToFile,
};
