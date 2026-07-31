require('dotenv').config();

const {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const { supabaseAdmin } = require('../src/config/supabaseClient');
const {
  createPageStorageRef,
  getPrivatePagesBucketName,
  parsePageStorageRef,
} = require('../src/utils/pageStorage');

const shouldApply = process.argv.includes('--apply');
const shouldDeleteSource = process.argv.includes('--delete-source');
const pageSize = 250;

if (shouldDeleteSource && !shouldApply) {
  throw new Error('--delete-source requires --apply');
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function encodeCopySource(bucket, key) {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function migratePage(page, targetBucket) {
  if (String(page.url_image || '').startsWith('r2://')) return 'already-private';

  const source = parsePageStorageRef(page.url_image);
  if (source.bucket === targetBucket) {
    throw new Error(`Page ${page.id}: source and private buckets must be distinct`);
  }

  const targetRef = createPageStorageRef(targetBucket, source.key);
  if (!shouldApply) {
    console.log(`[dry-run] page ${page.id}: ${source.bucket}/${source.key} -> ${targetRef}`);
    return 'planned';
  }

  const sourceHead = await client.send(new HeadObjectCommand({
    Bucket: source.bucket,
    Key: source.key,
  }));

  await client.send(new CopyObjectCommand({
    Bucket: targetBucket,
    Key: source.key,
    CopySource: encodeCopySource(source.bucket, source.key),
    ContentType: sourceHead.ContentType || 'application/octet-stream',
    CacheControl: 'private, no-store',
    MetadataDirective: 'REPLACE',
  }));

  const targetHead = await client.send(new HeadObjectCommand({ Bucket: targetBucket, Key: source.key }));
  if (sourceHead.ContentLength !== undefined && targetHead.ContentLength !== sourceHead.ContentLength) {
    throw new Error(`Page ${page.id}: copied object size mismatch`);
  }

  const { error } = await supabaseAdmin
    .from('pages')
    .update({ url_image: targetRef })
    .eq('id', page.id);
  if (error) throw error;

  if (shouldDeleteSource) {
    await client.send(new DeleteObjectCommand({ Bucket: source.bucket, Key: source.key }));
  }
  return 'migrated';
}

async function main() {
  const targetBucket = getPrivatePagesBucketName();
  if (!targetBucket) throw new Error('R2_PAGES_BUCKET_NAME is required');

  const counts = { planned: 0, migrated: 0, 'already-private': 0, failed: 0 };
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
