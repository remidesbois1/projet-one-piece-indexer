const { supabaseAdmin } = require('../config/supabaseClient');

function throwOnError(error) {
  if (error) throw error;
}

function createChapterImportRepository({ client = supabaseAdmin } = {}) {
  return {
    async begin(input) {
      const { data, error } = await client.rpc('begin_chapter_import', {
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_actor_id: input.actorId,
        p_tome_id: input.tomeId,
        p_chapter_number: input.chapterNumber,
        p_chapter_title: input.chapterTitle,
        p_archive_bucket: input.archiveBucket,
        p_archive_sha256: input.archiveSha256,
        p_archive_bytes: input.archiveBytes,
        p_total_entries: input.totalEntries,
        p_total_pages: input.totalPages,
      });
      throwOnError(error);
      return data;
    },

    async queue(jobId, actorId) {
      const { data, error } = await client.rpc('queue_chapter_import', {
        p_job_id: jobId,
        p_actor_id: actorId,
      });
      throwOnError(error);
      return data;
    },

    async claim(workerId, leaseSeconds) {
      const { data, error } = await client.rpc('claim_chapter_import', {
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
      throwOnError(error);
      return data;
    },

    async updateProgress(jobId, workerId, manifest, leaseSeconds) {
      const { data, error } = await client.rpc('update_chapter_import_progress', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_processed_pages: manifest.length,
        p_manifest: manifest,
        p_lease_seconds: leaseSeconds,
      });
      throwOnError(error);
      return data;
    },

    async heartbeat(jobId, workerId, leaseSeconds) {
      const { error } = await client.rpc('heartbeat_chapter_import', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
      throwOnError(error);
    },

    async finalize(jobId, workerId, manifest) {
      const { data, error } = await client.rpc('finalize_chapter_import', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_pages: manifest,
      });
      throwOnError(error);
      return data;
    },

    async fail(jobId, workerId, failure) {
      const { data, error } = await client.rpc('fail_chapter_import', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error_code: failure.code,
        p_error_message: failure.message,
        p_retryable: failure.retryable,
      });
      throwOnError(error);
      return data;
    },

    async get(jobId, actorId) {
      const { data, error } = await client
        .from('chapter_import_jobs')
        .select('*')
        .eq('id', jobId)
        .eq('created_by', actorId)
        .maybeSingle();
      throwOnError(error);
      return data;
    },

    async listCleanupJobs(limit = 10) {
      const { data, error } = await client
        .from('chapter_import_jobs')
        .select('id, status, archive_bucket, archive_key')
        .in('status', ['completed', 'failed', 'cancelled'])
        .is('source_deleted_at', null)
        .order('finished_at', { ascending: true })
        .limit(limit);
      throwOnError(error);
      return data || [];
    },

    async reapStale(limit = 25) {
      const { data, error } = await client.rpc('reap_stale_chapter_imports', { p_limit: limit });
      throwOnError(error);
      return Number(data) || 0;
    },

    async markSourceDeleted(jobId) {
      const { error } = await client.rpc('mark_chapter_import_source_deleted', { p_job_id: jobId });
      throwOnError(error);
    },
  };
}

function isMissingChapterImportSchema(error) {
  return error?.code === 'PGRST202'
    || error?.code === 'PGRST205'
    || /chapter_import_jobs|claim_chapter_import/i.test(error?.message || '');
}

module.exports = { createChapterImportRepository, isMissingChapterImportSchema };
