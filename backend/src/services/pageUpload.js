const fs = require('node:fs');

const inputLimits = require('@poneglyph/shared/input-limits.json');
const { inspectImageFile } = require('./chapterImportArchive');
const { requirePageImageContentType } = require('../utils/pageImageMime');

const PAGE_IMAGE_VALIDATION_CODES = new Set([
  'INVALID_IMAGE',
  'UNSUPPORTED_IMAGE',
  'UNSUPPORTED_PAGE_IMAGE',
  'PAGE_IMAGE_TOO_LARGE',
]);

function pageImageTooLargeError(maxBytes) {
  const error = new Error(`L’image de page dépasse la limite de ${maxBytes} octets.`);
  error.code = 'PAGE_IMAGE_TOO_LARGE';
  error.statusCode = 413;
  return error;
}

async function preparePageUpload(filePath, {
  inspect = inspectImageFile,
  readFile = fs.promises.readFile,
  stat = fs.promises.stat,
  maxBytes = inputLimits.pageImageBytes,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > inputLimits.pageImageBytes) {
    throw new TypeError(`maxBytes must be an integer between 1 and ${inputLimits.pageImageBytes}`);
  }
  const fileStats = await stat(filePath);
  if (!Number.isSafeInteger(fileStats?.size) || fileStats.size < 1) {
    const error = new Error('Le fichier image est vide ou sa taille est invalide.');
    error.code = 'INVALID_IMAGE';
    error.statusCode = 415;
    throw error;
  }
  if (fileStats.size > maxBytes) throw pageImageTooLargeError(maxBytes);

  const metadata = await inspect(filePath);
  const buffer = await readFile(filePath);
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) throw pageImageTooLargeError(maxBytes);
  const contentType = requirePageImageContentType(buffer);

  if (metadata.contentType !== contentType) {
    const error = new Error('Le format détecté ne correspond pas aux métadonnées de l’image.');
    error.code = 'UNSUPPORTED_PAGE_IMAGE';
    error.statusCode = 415;
    throw error;
  }

  return { buffer, contentType, metadata };
}

function isPageImageValidationError(error) {
  return PAGE_IMAGE_VALIDATION_CODES.has(error?.code);
}

module.exports = {
  isPageImageValidationError,
  pageImageTooLargeError,
  preparePageUpload,
};
