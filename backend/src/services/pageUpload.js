const fs = require('node:fs');

const { inspectImageFile } = require('./chapterImportArchive');
const { requirePageImageContentType } = require('../utils/pageImageMime');

const PAGE_IMAGE_VALIDATION_CODES = new Set([
  'INVALID_IMAGE',
  'UNSUPPORTED_IMAGE',
  'UNSUPPORTED_PAGE_IMAGE',
]);

async function preparePageUpload(filePath, {
  inspect = inspectImageFile,
  readFile = fs.promises.readFile,
} = {}) {
  const metadata = await inspect(filePath);
  const buffer = await readFile(filePath);
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
  preparePageUpload,
};
