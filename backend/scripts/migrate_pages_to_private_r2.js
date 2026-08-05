require('dotenv').config();

const crypto = require('node:crypto');
const {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const inputLimits = require('@poneglyph/shared/input-limits.json');
const { supabaseAdmin } = require('../src/config/supabaseClient');
const {
  createPageStorageRef,
  getPrivatePagesBucketName,
  parsePageStorageRef,
} = require('../src/utils/pageStorage');

const shouldApply = process.argv.includes('--apply');
const shouldDeleteSource = process.argv.includes('--delete-source');
const pageSize = 250;
const SOURCE_BUCKET_METADATA = 'page-migration-source-bucket';
const SOURCE_KEY_HASH_METADATA = 'page-migration-source-key-sha256';

if (shouldDeleteSource && !shouldApply) {
  throw new Error('--delete-source requires --apply');
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function encodeCopySource(bucket, key) {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function hashStorageKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function validateMigrationObject(metadata, { maxBytes = inputLimits.pageImageBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > inputLimits.pageImageBytes) {
    throw new TypeError(`maxBytes must be an integer between 1 and ${inputLimits.pageImageBytes}`);
  }
  const contentLength = metadata?.ContentLength;
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    const error = new Error('L’objet source a une taille invalide.');
    error.code = 'INVALID_PAGE_IMAGE_LENGTH';
    throw error;
  }
  if (contentLength > maxBytes) {
    const error = new Error(`L’objet source dépasse la limite de ${maxBytes} octets.`);
    error.code = 'PAGE_IMAGE_TOO_LARGE';
    throw error;
  }
  return contentLength;
}

function createMigrationMetadata(source) {
  return {
    [SOURCE_BUCKET_METADATA]: source.bucket,
    [SOURCE_KEY_HASH_METADATA]: hashStorageKey(source.key),
  };
}

function hasMatchingMigrationMarker(targetHead, sourceBucket, key) {
  const metadata = targetHead?.Metadata || {};
  return metadata[SOURCE_BUCKET_METADATA] === sourceBucket
    && metadata[SOURCE_KEY_HASH_METADATA] === hashStorageKey(key);
}

async function migratePage(page, targetBucket, {
  storageClient = client,
  database = supabaseAdmin,
  apply = shouldApply,
  deleteSource = shouldDeleteSource,
  legacyPublicUrl = process.env.R2_PUBLIC_URL,
  legacyBucket = process.env.R2_BUCKET_NAME,
  log = console.log,
} = {}) {
  if (deleteSource && !apply) throw new Error('deleteSource requires apply');
  const reference = String(page.url_image || '');
  const source = parsePageStorageRef(reference, {
    allowedBuckets: [targetBucket],
    legacyPublicUrl,
    legacyBucket,
  });
  if (reference.startsWith('r2://')) {
    if (!deleteSource) return 'already-private';
    if (!legacyBucket || legacyBucket === targetBucket) {
      throw new Error(`Page ${page.id}: legacy source bucket is missing or matches the private bucket`);
    }
    createPageStorageRef(legacyBucket, source.key);
    const targetHead = await storageClient.send(new HeadObjectCommand({
      Bucket: targetBucket,
      Key: source.key,
    }));
    validateMigrationObject(targetHead);
    if (!hasMatchingMigrationMarker(targetHead, legacyBucket, source.key)) {
      return 'already-private';
    }
    await storageClient.send(new DeleteObjectCommand({ Bucket: legacyBucket, Key: source.key }));
    return 'purged-legacy';
  }
  if (source.bucket === targetBucket) {
    throw new Error(`Page ${page.id}: source and private buckets must be distinct`);
  }

  const targetRef = createPageStorageRef(targetBucket, source.key);
  const sourceHead = await storageClient.send(new HeadObjectCommand({
    Bucket: source.bucket,
    Key: source.key,
  }));
  const sourceLength = validateMigrationObject(sourceHead);

  if (!apply) {
    log(`[dry-run] page ${page.id}: ${source.bucket}/${source.key} -> ${targetRef}`);
    return 'planned';
  }

  await storageClient.send(new CopyObjectCommand({
    Bucket: targetBucket,
    Key: source.key,
    CopySource: encodeCopySource(source.bucket, source.key),
    ...(sourceHead.ETag ? { CopySourceIfMatch: sourceHead.ETag } : {}),
    ContentType: sourceHead.ContentType || 'application/octet-stream',
    CacheControl: 'private, no-store',
    MetadataDirective: 'REPLACE',
    Metadata: createMigrationMetadata(source),
  }));

  const targetHead = await storageClient.send(new HeadObjectCommand({ Bucket: targetBucket, Key: source.key }));
  const targetLength = validateMigrationObject(targetHead);
  if (targetLength !== sourceLength) {
    throw new Error(`Page ${page.id}: copied object size mismatch`);
  }
  if (!hasMatchingMigrationMarker(targetHead, source.bucket, source.key)) {
    throw new Error(`Page ${page.id}: copied object is missing its migration marker`);
  }

  const { error } = await database
    .from('pages')
    .update({ url_image: targetRef })
    .eq('id', page.id);
  if (error) throw error;

  if (deleteSource) {
    await storageClient.send(new DeleteObjectCommand({ Bucket: source.bucket, Key: source.key }));
  }
  return 'migrated';
}

async function main() {
  const targetBucket = getPrivatePagesBucketName();
  if (!targetBucket) throw new Error('R2_PAGES_BUCKET_NAME is required');

  const counts = { planned: 0, migrated: 0, 'already-private': 0, 'purged-legacy': 0, failed: 0 };
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabaseAdmin
      .from('pages')
      .select('id, url_image')
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;

    for (const page of data) {
      try {
        const status = await migratePage(page, targetBucket);
        counts[status] += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`Page ${page.id}: ${error.message}`);
      }
    }
    if (data.length < pageSize) break;
  }

  console.log(JSON.stringify({ mode: shouldApply ? 'apply' : 'dry-run', deleteSource: shouldDeleteSource, counts }, null, 2));
  if (counts.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createMigrationMetadata,
  hasMatchingMigrationMarker,
  main,
  migratePage,
  validateMigrationObject,
};
