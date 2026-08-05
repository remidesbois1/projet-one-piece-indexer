const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { Readable, Transform } = require('node:stream');
const inputLimits = require('@poneglyph/shared/input-limits.json');

const MAX_PAGE_IMAGE_BYTES = inputLimits.pageImageBytes;
const MAX_PAGE_STORAGE_KEY_BYTES = 1024;
const DEFAULT_PAGE_IMAGE_TIMEOUT_MS = 15_000;
const MAX_PAGE_IMAGE_TIMEOUT_MS = 60_000;
const BUCKET_NAME_PATTERN = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

class PageStorageError extends Error {
  constructor(code, message, { statusCode = 400 } = {}) {
    super(message);
    this.name = 'PageStorageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const r2Client = new S3Client({
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

function assertBucketName(bucket) {
  if (
    typeof bucket !== 'string'
    || !BUCKET_NAME_PATTERN.test(bucket)
    || bucket.includes('..')
    || bucket.includes('.-')
    || bucket.includes('-.')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new PageStorageError('INVALID_PAGE_BUCKET', 'Le bucket de pages configure est invalide.', {
      statusCode: 500,
    });
  }
  return bucket;
}

function getPrivatePagesBucketName() {
  const bucket = process.env.R2_PAGES_BUCKET_NAME;
  if (bucket) return assertBucketName(bucket);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('R2_PAGES_BUCKET_NAME must reference a private bucket in production');
  }
  const fallback = process.env.R2_BUCKET_NAME;
  return fallback ? assertBucketName(fallback) : fallback;
}

function normalizePageStorageKey(key) {
  if (
    typeof key !== 'string'
    || key.length === 0
    || key.startsWith('/')
    || key.includes('\\')
    || /[\0-\x1f\x7f]/.test(key)
  ) {
    throw new PageStorageError('INVALID_PAGE_KEY', 'La cle de stockage de la page est invalide.');
  }

  const normalized = key;
  const segments = normalized.split('/');
  if (
    !normalized
    || Buffer.byteLength(normalized, 'utf8') > MAX_PAGE_STORAGE_KEY_BYTES
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new PageStorageError('INVALID_PAGE_KEY', 'La cle de stockage de la page est invalide.');
  }
  return segments.join('/');
}

function encodeStorageKey(key) {
  return normalizePageStorageKey(key).split('/').map(encodeURIComponent).join('/');
}

function decodeCanonicalStoragePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference de stockage de la page est invalide.');
  }

  const encodedSegments = pathname.slice(1).split('/');
  if (encodedSegments.length === 0 || encodedSegments.some((segment) => !segment)) {
    throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference de stockage de la page est invalide.');
  }

  const decodedSegments = encodedSegments.map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference de stockage de la page est invalide.');
    }
    if (
      encodeURIComponent(decoded) !== segment
      || !decoded
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || /[\0-\x1f\x7f]/.test(decoded)
    ) {
      throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference de stockage de la page est invalide.');
    }
    return decoded;
  });

  return decodedSegments.join('/');
}

function createPageStorageRef(bucket, key) {
  const safeBucket = assertBucketName(bucket);
  return `r2://${safeBucket}/${encodeStorageKey(key)}`;
}

function getAllowedPageBuckets(allowedBuckets) {
  const configured = allowedBuckets === undefined
    ? process.env.R2_PAGES_BUCKET_NAME
      ? [process.env.R2_PAGES_BUCKET_NAME]
      : process.env.NODE_ENV === 'production'
        ? []
        : [process.env.R2_BUCKET_NAME].filter(Boolean)
    : allowedBuckets;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new PageStorageError('PAGE_BUCKET_NOT_CONFIGURED', 'Aucun bucket de pages autorise n’est configure.', {
      statusCode: 500,
    });
  }
  return new Set(configured.map(assertBucketName));
}

function parseUrl(value, errorMessage) {
  try {
    return new URL(value);
  } catch {
    throw new PageStorageError('INVALID_PAGE_REFERENCE', errorMessage);
  }
}

function assertNoUrlSecrets(parsed) {
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference de stockage contient des composants interdits.');
  }
}

function parsePageStorageRef(reference, {
  allowedBuckets,
  legacyPublicUrl = process.env.R2_PUBLIC_URL,
  legacyBucket = process.env.R2_BUCKET_NAME,
} = {}) {
  if (
    typeof reference !== 'string'
    || !reference
    || reference !== reference.trim()
    || /[\0-\x1f\x7f]/.test(reference)
  ) {
    throw new PageStorageError('INVALID_PAGE_REFERENCE', 'Page storage reference is missing');
  }

  const buckets = getAllowedPageBuckets(allowedBuckets);

  if (reference.startsWith('r2://')) {
    const parsed = parseUrl(reference, 'Invalid R2 page storage reference');
    assertNoUrlSecrets(parsed);
    const bucket = assertBucketName(parsed.hostname);
    if (!buckets.has(bucket)) {
      throw new PageStorageError('PAGE_BUCKET_NOT_ALLOWED', 'Le bucket de cette page n’est pas autorise.', {
        statusCode: 403,
      });
    }
    const key = decodeCanonicalStoragePath(parsed.pathname);
    if (reference !== createPageStorageRef(bucket, key)) {
      throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference R2 de la page n’est pas canonique.');
    }
    return { bucket, key };
  }

  if (legacyPublicUrl && legacyBucket) {
    const base = parseUrl(legacyPublicUrl, 'Invalid legacy R2 public URL configuration');
    const basePath = base.pathname === '/'
      ? ''
      : base.pathname.replace(/\/$/, '');
    if (
      base.protocol !== 'https:'
      || base.username
      || base.password
      || base.port
      || base.search
      || base.hash
    ) {
      throw new PageStorageError('INVALID_LEGACY_PAGE_ORIGIN', 'La configuration publique R2 legacy est invalide.', {
        statusCode: 500,
      });
    }

    const parsed = parseUrl(reference, 'Invalid legacy R2 page URL');
    assertNoUrlSecrets(parsed);
    if (
      parsed.protocol !== 'https:'
      || parsed.origin !== base.origin
      || parsed.hostname !== base.hostname
      || !parsed.pathname.startsWith(`${basePath}/`)
    ) {
      throw new PageStorageError('INVALID_PAGE_REFERENCE', 'Page media must use the configured R2 storage');
    }

    const bucket = assertBucketName(legacyBucket);
    const key = decodeCanonicalStoragePath(parsed.pathname.slice(basePath.length));
    const canonical = `${base.origin}${basePath}/${encodeStorageKey(key)}`;
    if (reference !== canonical) {
      throw new PageStorageError('INVALID_PAGE_REFERENCE', 'La reference legacy de la page n’est pas canonique.');
    }
    return { bucket, key };
  }

  throw new PageStorageError('INVALID_PAGE_REFERENCE', 'Page media must use the configured R2 storage');
}

function validateMaximum(value, hardMaximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${hardMaximum}`);
  }
  return value;
}

function pageImageTooLargeError(maxBytes) {
  return new PageStorageError(
    'PAGE_IMAGE_TOO_LARGE',
    `L’image de page depasse la limite de ${maxBytes} octets.`,
    { statusCode: 413 }
  );
}

function pageImageTimeoutError(timeoutMs) {
  return new PageStorageError(
    'PAGE_IMAGE_TIMEOUT',
    `Le stockage n’a pas repondu dans le delai de ${timeoutMs} ms.`,
    { statusCode: 504 }
  );
}

function createAbortContext({ signal, timeoutMs }) {
  const controller = new AbortController();
  let reason = null;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  abortPromise.catch(() => {});

  const abort = (error) => {
    if (controller.signal.aborted) return;
    reason = error instanceof Error ? error : new Error('Page image request aborted');
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onExternalAbort = () => abort(signal.reason);
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => abort(pageImageTimeoutError(timeoutMs)), timeoutMs);

  let cleaned = false;
  return {
    abortPromise,
    signal: controller.signal,
    get reason() { return reason; },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function destroyBody(body) {
  if (typeof body?.destroy === 'function' && !body.destroyed) body.destroy();
  else if (typeof body?.cancel === 'function') Promise.resolve(body.cancel()).catch(() => {});
}

function assertBufferSize(value, maxBytes) {
  const bytes = Buffer.isBuffer(value) ? value.length : value.byteLength;
  if (bytes > maxBytes) throw pageImageTooLargeError(maxBytes);
}

function createBoundedBody(body, { maxBytes, abortContext }) {
  if (!body) {
    abortContext.cleanup();
    throw new PageStorageError('EMPTY_PAGE_IMAGE', 'R2 returned an empty page object', { statusCode: 502 });
  }
  if (abortContext.signal.aborted) {
    destroyBody(body);
    abortContext.cleanup();
    throw abortContext.reason || new Error('Page image request aborted');
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    try {
      assertBufferSize(body, maxBytes);
      return body;
    } finally {
      abortContext.cleanup();
    }
  }

  let source = body;
  if (typeof body.pipe !== 'function') {
    if (typeof body.getReader === 'function') source = Readable.fromWeb(body);
    else if (body[Symbol.asyncIterator]) source = Readable.from(body, { objectMode: false });
    else {
      destroyBody(body);
      abortContext.cleanup();
      throw new PageStorageError('UNSUPPORTED_PAGE_STREAM', 'R2 returned an unsupported page stream', {
        statusCode: 502,
      });
    }
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        callback(pageImageTooLargeError(maxBytes));
        return;
      }
      callback(null, buffer);
    },
  });
  const onSourceError = (error) => limiter.destroy(error);
  const onAbort = () => {
    destroyBody(source);
    limiter.destroy(abortContext.reason || new Error('Page image request aborted'));
  };
  source.once('error', onSourceError);
  abortContext.signal.addEventListener('abort', onAbort, { once: true });
  limiter.once('close', () => {
    source.removeListener('error', onSourceError);
    abortContext.signal.removeEventListener('abort', onAbort);
    if (!source.destroyed && !source.readableEnded) destroyBody(source);
    abortContext.cleanup();
  });
  source.pipe(limiter);
  return limiter;
}

async function bodyToBuffer(body, { maxBytes = MAX_PAGE_IMAGE_BYTES } = {}) {
  if (!body) throw new PageStorageError('EMPTY_PAGE_IMAGE', 'R2 returned an empty page object', { statusCode: 502 });
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    assertBufferSize(body, maxBytes);
    return Buffer.from(body);
  }
  if (!body[Symbol.asyncIterator]) {
    destroyBody(body);
    throw new PageStorageError('UNSUPPORTED_PAGE_STREAM', 'R2 returned an unsupported page stream', {
      statusCode: 502,
    });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw pageImageTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function openPageImage(reference, {
  client = r2Client,
  allowedBuckets,
  legacyPublicUrl,
  legacyBucket,
  maxBytes = MAX_PAGE_IMAGE_BYTES,
  timeoutMs = DEFAULT_PAGE_IMAGE_TIMEOUT_MS,
  signal,
} = {}) {
  validateMaximum(maxBytes, MAX_PAGE_IMAGE_BYTES, 'maxBytes');
  validateMaximum(timeoutMs, MAX_PAGE_IMAGE_TIMEOUT_MS, 'timeoutMs');
  const { bucket, key } = parsePageStorageRef(reference, {
    allowedBuckets,
    legacyPublicUrl,
    legacyBucket,
  });
  const abortContext = createAbortContext({ signal, timeoutMs });
  if (abortContext.signal.aborted) {
    abortContext.cleanup();
    throw abortContext.reason;
  }

  let response;
  try {
    response = await Promise.race([
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: abortContext.signal,
      }),
      abortContext.abortPromise,
    ]);
  } catch (error) {
    abortContext.cleanup();
    throw abortContext.reason || error;
  }

  const contentLength = response.ContentLength ?? null;
  if (
    contentLength !== null
    && (!Number.isSafeInteger(contentLength) || contentLength < 0)
  ) {
    destroyBody(response.Body);
    abortContext.cleanup();
    throw new PageStorageError('INVALID_PAGE_IMAGE_LENGTH', 'R2 returned an invalid page size', {
      statusCode: 502,
    });
  }
  if (contentLength !== null && contentLength > maxBytes) {
    destroyBody(response.Body);
    abortContext.cleanup();
    throw pageImageTooLargeError(maxBytes);
  }

  let body;
  try {
    body = createBoundedBody(response.Body, { maxBytes, abortContext });
  } catch (error) {
    destroyBody(response.Body);
    abortContext.cleanup();
    throw error;
  }
  return {
    body,
    contentType: response.ContentType || 'application/octet-stream',
    contentLength,
    bucket,
    key,
  };
}

async function readPageImage(reference, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_PAGE_IMAGE_BYTES;
  const image = await openPageImage(reference, options);
  return {
    ...image,
    buffer: await bodyToBuffer(image.body, { maxBytes }),
  };
}

module.exports = {
  DEFAULT_PAGE_IMAGE_TIMEOUT_MS,
  MAX_PAGE_IMAGE_BYTES,
  PageStorageError,
  bodyToBuffer,
  createPageStorageRef,
  getPrivatePagesBucketName,
  normalizePageStorageKey,
  openPageImage,
  parsePageStorageRef,
  readPageImage,
};
