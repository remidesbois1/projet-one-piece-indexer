const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      }
    : undefined,
});

function getPrivatePagesBucketName() {
  const bucket = process.env.R2_PAGES_BUCKET_NAME;
  if (bucket) return bucket;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('R2_PAGES_BUCKET_NAME must reference a private bucket in production');
  }
  return process.env.R2_BUCKET_NAME;
}

function createPageStorageRef(bucket, key) {
  if (!bucket || !key) throw new Error('Page storage bucket and key are required');
  const encodedKey = String(key)
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `r2://${bucket}/${encodedKey}`;
}

function parsePageStorageRef(reference) {
  if (!reference || typeof reference !== 'string') {
    throw new Error('Page storage reference is missing');
  }

  if (reference.startsWith('r2://')) {
    const parsed = new URL(reference);
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    if (!parsed.hostname || !key) throw new Error('Invalid R2 page storage reference');
    return { bucket: parsed.hostname, key };
  }

  const publicBase = process.env.R2_PUBLIC_URL;
  if (publicBase) {
    const base = new URL(publicBase);
    const parsed = new URL(reference);
    if (parsed.origin === base.origin) {
      const basePath = base.pathname.replace(/\/$/, '');
      const key = decodeURIComponent(parsed.pathname.slice(basePath.length).replace(/^\/+/, ''));
      if (!key) throw new Error('Invalid legacy R2 page URL');
      return { bucket: process.env.R2_BUCKET_NAME, key };
    }
  }

  throw new Error('Page media must use the configured R2 storage');
}

async function bodyToBuffer(body) {
  if (!body) throw new Error('R2 returned an empty page object');
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function openPageImage(reference, { client = r2Client } = {}) {
  const { bucket, key } = parsePageStorageRef(reference);
  if (!bucket) throw new Error('R2 page bucket is not configured');

  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    body: response.Body,
    contentType: response.ContentType || 'application/octet-stream',
    contentLength: response.ContentLength ?? null,
    bucket,
    key,
  };
}

async function readPageImage(reference, options = {}) {
  const image = await openPageImage(reference, options);
  return {
    ...image,
    buffer: await bodyToBuffer(image.body),
  };
}

module.exports = {
  createPageStorageRef,
  getPrivatePagesBucketName,
  openPageImage,
  parsePageStorageRef,
  readPageImage,
};
