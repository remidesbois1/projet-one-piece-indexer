const { Readable } = require('node:stream');

const MAX_SIGNATURE_BYTES = 4096;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class UnsupportedPageImageError extends Error {
  constructor(message = 'Le contenu stocké n’est pas une image JPEG, PNG, WebP ou AVIF valide.') {
    super(message);
    this.name = 'UnsupportedPageImageError';
    this.code = 'UNSUPPORTED_PAGE_IMAGE';
    this.statusCode = 415;
  }
}

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function hasAvifBrand(buffer) {
  if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;

  const declaredSize = buffer.readUInt32BE(0);
  let payloadOffset = 8;
  let boxSize = declaredSize;

  if (declaredSize === 1) {
    if (buffer.length < 24) return false;
    const largeSize = buffer.readBigUInt64BE(8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    boxSize = Number(largeSize);
    payloadOffset = 16;
  } else if (declaredSize === 0) {
    boxSize = buffer.length;
  }

  if (boxSize < payloadOffset + 8) return false;
  const availableEnd = Math.min(boxSize, buffer.length);
  if (availableEnd < payloadOffset + 8) return false;

  const isAvifBrand = (offset) => {
    const brand = buffer.toString('ascii', offset, offset + 4);
    return brand === 'avif' || brand === 'avis';
  };

  if (isAvifBrand(payloadOffset)) return true;
  for (let offset = payloadOffset + 8; offset + 4 <= availableEnd; offset += 4) {
    if (isAvifBrand(offset)) return true;
  }
  return false;
}

function detectPageImageContentType(value) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;
  if (!buffer) return null;

  if (startsWith(buffer, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (
    buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (hasAvifBrand(buffer)) return 'image/avif';
  return null;
}

function requirePageImageContentType(value) {
  const contentType = detectPageImageContentType(value);
  if (!contentType) throw new UnsupportedPageImageError();
  return contentType;
}

async function closeSource(iterator, source) {
  try {
    if (typeof iterator?.return === 'function') await iterator.return();
  } catch {
    // The detection error remains the actionable failure for the caller.
  } finally {
    if (typeof source?.destroy === 'function' && !source.destroyed) source.destroy();
  }
}

async function toReadableBody(body) {
  if (!body) throw new Error('R2 returned an empty page object');
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (body[Symbol.asyncIterator]) return Readable.from(body, { objectMode: false });
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  throw new Error('R2 returned an unsupported page stream');
}

async function sniffPageImageBody(body, { maxSignatureBytes = MAX_SIGNATURE_BYTES } = {}) {
  if (
    !Number.isSafeInteger(maxSignatureBytes)
    || maxSignatureBytes < 24
    || maxSignatureBytes > MAX_SIGNATURE_BYTES
  ) {
    throw new TypeError(`maxSignatureBytes must be an integer between 24 and ${MAX_SIGNATURE_BYTES}`);
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return {
      body,
      contentType: requirePageImageContentType(body.subarray(0, maxSignatureBytes)),
    };
  }

  const source = await toReadableBody(body);
  if (Buffer.isBuffer(source)) return sniffPageImageBody(source, { maxSignatureBytes });

  const iterator = source[Symbol.asyncIterator]();
  const replayChunks = [];
  let bufferedBytes = 0;
  let sourceEnded = false;

  try {
    while (bufferedBytes < maxSignatureBytes) {
      const step = await iterator.next();
      if (step.done) {
        sourceEnded = true;
        break;
      }

      const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
      if (chunk.length === 0) continue;
      replayChunks.push(chunk);
      bufferedBytes += chunk.length;

      const signature = Buffer.concat(replayChunks, Math.min(bufferedBytes, maxSignatureBytes));
      const contentType = detectPageImageContentType(signature);
      if (contentType) {
        async function* replay() {
          let completed = false;
          try {
            for (const bufferedChunk of replayChunks) yield bufferedChunk;
            if (!sourceEnded) {
              while (true) {
                const remaining = await iterator.next();
                if (remaining.done) break;
                yield Buffer.isBuffer(remaining.value) ? remaining.value : Buffer.from(remaining.value);
              }
            }
            completed = true;
          } finally {
            if (!completed) await closeSource(iterator, source);
          }
        }

        return {
          body: Readable.from(replay(), { objectMode: false }),
          contentType,
        };
      }
    }
  } catch (error) {
    await closeSource(iterator, source);
    throw error;
  }

  await closeSource(iterator, source);
  throw new UnsupportedPageImageError();
}

module.exports = {
  MAX_SIGNATURE_BYTES,
  UnsupportedPageImageError,
  detectPageImageContentType,
  requirePageImageContentType,
  sniffPageImageBody,
};
