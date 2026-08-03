begin;

create table if not exists public.chapter_import_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  tome_id bigint not null references public.tomes(id) on delete cascade,
  chapter_number integer not null check (chapter_number between 1 and 100000),
  chapter_title varchar(255) not null check (char_length(btrim(chapter_title)) between 1 and 255),
  archive_bucket text not null check (char_length(archive_bucket) between 1 and 255),
  archive_key text not null check (archive_key ~ '^_chapter-imports/[0-9a-f-]{36}/source\.cbz$'),
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes bigint not null check (archive_bytes between 1 and 536870912),
  status text not null default 'receiving' check (
    status in ('receiving', 'queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  total_entries integer not null check (total_entries between 1 and 1000),
  total_pages integer not null check (total_pages between 1 and 500),
  processed_pages integer not null default 0 check (
    processed_pages >= 0 and processed_pages <= total_pages
  ),
  manifest jsonb not null default '[]'::jsonb check (jsonb_typeof(manifest) = 'array'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  chapter_id bigint unique references public.chapitres(id) on delete set null,
  error_code text,
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  started_at timestamptz,
  finished_at timestamptz,
  source_deleted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, idempotency_key)
);

create unique index if not exists chapter_import_jobs_active_chapter_idx
  on public.chapter_import_jobs (tome_id, chapter_number)
  where status in ('receiving', 'queued', 'processing');

create index if not exists chapter_import_jobs_queue_idx
  on public.chapter_import_jobs (next_attempt_at, created_at)
  where status in ('queued', 'processing');

create index if not exists chapter_import_jobs_cleanup_idx
  on public.chapter_import_jobs (finished_at)
  where status in ('completed', 'failed') and source_deleted_at is null;

create index if not exists chapter_import_jobs_reaper_idx
  on public.chapter_import_jobs (expires_at, lease_expires_at)
  where status in ('receiving', 'processing');

alter table public.chapter_import_jobs enable row level security;
revoke all on table public.chapter_import_jobs from public, anon, authenticated;
grant all on table public.chapter_import_jobs to service_role;

create or replace function public.begin_chapter_import(
  p_idempotency_key text,
  p_request_hash text,
  p_actor_id uuid,
  p_tome_id bigint,
  p_chapter_number integer,
  p_chapter_title text,
  p_archive_bucket text,
  p_archive_sha256 text,
  p_archive_bytes bigint,
  p_total_entries integer,
  p_total_pages integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor_role public.role_type;
  v_job public.chapter_import_jobs%rowtype;
  v_job_id uuid;
begin
  select role into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if not found or v_actor_role <> 'Admin'::public.role_type then
    raise exception using errcode = '42501', message = 'Seul un administrateur peut importer un chapitre.';
  end if;

  -- Resolve an idempotent replay before checking current chapter state. Once a
  -- job completes, its chapter necessarily exists and must not turn a safe
  -- retry (for example after a lost HTTP response) into a conflict.
  select * into v_job
  from public.chapter_import_jobs
  where created_by = p_actor_id
    and idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_job.request_hash <> p_request_hash then
      raise exception using errcode = '22000', message = 'Cette clé d’idempotence correspond à une autre requête.';
    end if;
    return to_jsonb(v_job);
  end if;

  if not exists (select 1 from public.tomes where id = p_tome_id) then
    raise exception using errcode = 'P0002', message = 'Tome introuvable.';
  end if;
  if exists (
    select 1 from public.chapitres
    where id_tome = p_tome_id and numero = p_chapter_number
  ) then
    raise exception using errcode = '23505', message = 'Ce chapitre existe déjà.';
  end if;

  v_job_id := extensions.gen_random_uuid();
  begin
    insert into public.chapter_import_jobs (
      id,
      idempotency_key,
      request_hash,
      created_by,
      tome_id,
      chapter_number,
      chapter_title,
      archive_bucket,
      archive_key,
      archive_sha256,
      archive_bytes,
      total_entries,
      total_pages
    ) values (
      v_job_id,
      p_idempotency_key,
      p_request_hash,
      p_actor_id,
      p_tome_id,
      p_chapter_number,
      btrim(p_chapter_title),
      p_archive_bucket,
      format('_chapter-imports/%s/source.cbz', v_job_id),
      p_archive_sha256,
      p_archive_bytes,
      p_total_entries,
      p_total_pages
    )
    returning * into v_job;
  exception when unique_violation then
    select * into v_job
    from public.chapter_import_jobs
    where created_by = p_actor_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_job.request_hash <> p_request_hash then
        raise exception using errcode = '22000', message = 'Cette clé d’idempotence correspond à une autre requête.';
      end if;
      return to_jsonb(v_job);
    end if;
    raise exception using errcode = '23505', message = 'Un import est déjà actif pour ce chapitre.';
  end;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.queue_chapter_import(
  p_job_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.chapter_import_jobs%rowtype;
begin
  select * into v_job
  from public.chapter_import_jobs
  where id = p_job_id
    and created_by = p_actor_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Import introuvable.';
  end if;
  if v_job.status = 'receiving' then
    update public.chapter_import_jobs
    set status = 'queued', next_attempt_at = now(), updated_at = now(), error_code = null, error_message = null
    where id = p_job_id
    returning * into v_job;
  elsif v_job.status not in ('queued', 'processing', 'completed') then
    raise exception using errcode = '55000', message = 'Cet import ne peut plus être mis en file.';
  end if;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.claim_chapter_import(
  p_worker_id text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.chapter_import_jobs%rowtype;
begin
  if char_length(coalesce(p_worker_id, '')) not between 1 and 200
     or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Paramètres de worker invalides.';
  end if;

  select * into v_job
  from public.chapter_import_jobs
  where attempt_count < max_attempts
    and (
      (status = 'queued' and next_attempt_at <= now())
      or (status = 'processing' and lease_expires_at < now())
    )
  order by next_attempt_at, created_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.chapter_import_jobs
  set
    status = 'processing',
    lease_owner = p_worker_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempt_count = attempt_count + 1,
    started_at = coalesce(started_at, now()),
    updated_at = now(),
    error_code = null,
    error_message = null
  where id = v_job.id
  returning * into v_job;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.update_chapter_import_progress(
  p_job_id uuid,
  p_worker_id text,
  p_processed_pages integer,
  p_manifest jsonb,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.chapter_import_jobs%rowtype;
begin
  select * into v_job
  from public.chapter_import_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Import introuvable.';
  end if;
  if v_job.status <> 'processing'
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at < now() then
    raise exception using errcode = '55000', message = 'Le bail du worker n’est plus valide.';
  end if;
  if p_processed_pages < 0
     or p_processed_pages > v_job.total_pages
     or jsonb_typeof(p_manifest) <> 'array'
     or jsonb_array_length(p_manifest) <> p_processed_pages then
    raise exception using errcode = '22023', message = 'Progression d’import invalide.';
  end if;

  update public.chapter_import_jobs
  set
    processed_pages = p_processed_pages,
    manifest = p_manifest,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.heartbeat_chapter_import(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Durée de bail invalide.';
  end if;

  update public.chapter_import_jobs
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and lease_owner = p_worker_id;

  if not found then
    raise exception using errcode = '55000', message = 'Le worker ne possède plus cet import.';
  end if;
end;
$$;

create or replace function public.fail_chapter_import(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.chapter_import_jobs%rowtype;
  v_retry_delay integer;
begin
  select * into v_job
  from public.chapter_import_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Import introuvable.';
  end if;
  if v_job.status <> 'processing' or v_job.lease_owner is distinct from p_worker_id then
    raise exception using errcode = '55000', message = 'Le worker ne possède plus cet import.';
  end if;

  if p_retryable and v_job.attempt_count < v_job.max_attempts then
    v_retry_delay := least(300, greatest(2, power(2, v_job.attempt_count)::integer));
    update public.chapter_import_jobs
    set
      status = 'queued',
      next_attempt_at = now() + make_interval(secs => v_retry_delay),
      lease_owner = null,
      lease_expires_at = null,
      error_code = left(coalesce(p_error_code, 'TRANSIENT_ERROR'), 100),
      error_message = left(coalesce(p_error_message, 'Erreur temporaire.'), 2000),
      updated_at = now()
    where id = p_job_id
    returning * into v_job;
  else
    update public.chapter_import_jobs
    set
      status = 'failed',
      lease_owner = null,
      lease_expires_at = null,
      error_code = left(coalesce(p_error_code, 'IMPORT_FAILED'), 100),
      error_message = left(coalesce(p_error_message, 'Échec de l’import.'), 2000),
      finished_at = now(),
      updated_at = now()
    where id = p_job_id
    returning * into v_job;
  end if;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.finalize_chapter_import(
  p_job_id uuid,
  p_worker_id text,
  p_pages jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.chapter_import_jobs%rowtype;
  v_chapter_id bigint;
  v_prefix text;
  v_count integer;
  v_distinct_numbers integer;
  v_distinct_urls integer;
  v_min_number integer;
  v_max_number integer;
begin
  select * into v_job
  from public.chapter_import_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Import introuvable.';
  end if;
  if v_job.status = 'completed' then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'processing'
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at < now() then
    raise exception using errcode = '55000', message = 'Le bail du worker n’est plus valide.';
  end if;
  if jsonb_typeof(p_pages) <> 'array'
     or jsonb_array_length(p_pages) <> v_job.total_pages
     or p_pages <> v_job.manifest then
    raise exception using errcode = '22023', message = 'Manifest final incomplet ou incohérent.';
  end if;

  v_prefix := format('r2://%s/_chapter-imports/%s/pages/', v_job.archive_bucket, v_job.id);

  select
    count(*),
    count(distinct page_number),
    count(distinct url_image),
    min(page_number),
    max(page_number)
  into v_count, v_distinct_numbers, v_distinct_urls, v_min_number, v_max_number
  from (
    select
      (item ->> 'numero_page')::integer as page_number,
      item ->> 'url_image' as url_image,
      item ->> 'sha256' as sha256
    from jsonb_array_elements(p_pages) as entries(item)
  ) as parsed
  where left(url_image, char_length(v_prefix)) = v_prefix
    and sha256 ~ '^[0-9a-f]{64}$';

  if v_count <> v_job.total_pages
     or v_distinct_numbers <> v_job.total_pages
     or v_distinct_urls <> v_job.total_pages
     or v_min_number <> 1
     or v_max_number <> v_job.total_pages then
    raise exception using errcode = '22023', message = 'Les pages finales doivent être uniques, contiguës et appartenir à l’import.';
  end if;

  insert into public.chapitres (id_tome, numero, titre)
  values (v_job.tome_id, v_job.chapter_number, v_job.chapter_title)
  returning id into v_chapter_id;

  insert into public.pages (id_chapitre, numero_page, url_image, statut)
  select
    v_chapter_id,
    (item ->> 'numero_page')::integer,
    item ->> 'url_image',
    'not_started'::public.page_status
  from jsonb_array_elements(p_pages) as entries(item)
  order by (item ->> 'numero_page')::integer;

  update public.chapter_import_jobs
  set
    status = 'completed',
    processed_pages = total_pages,
    chapter_id = v_chapter_id,
    lease_owner = null,
    lease_expires_at = null,
    finished_at = now(),
    updated_at = now(),
    error_code = null,
    error_message = null
  where id = p_job_id
  returning * into v_job;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.reap_stale_chapter_imports(
  p_limit integer default 25
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reaped integer;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de nettoyage invalide.';
  end if;

  with stale_jobs as (
    select id
    from public.chapter_import_jobs
    where
      (status = 'receiving' and expires_at < now())
      or (
        status = 'processing'
        and lease_expires_at < now()
        and attempt_count >= max_attempts
      )
    order by coalesce(lease_expires_at, expires_at), created_at
    for update skip locked
    limit p_limit
  ), reaped as (
    update public.chapter_import_jobs as jobs
    set
      status = 'failed',
      lease_owner = null,
      lease_expires_at = null,
      error_code = case
        when jobs.status = 'receiving' then 'RECEPTION_EXPIRED'
        else 'IMPORT_ATTEMPTS_EXHAUSTED'
      end,
      error_message = case
        when jobs.status = 'receiving' then 'La réception de l’archive a expiré avant sa mise en file.'
        else 'Le worker a épuisé ses tentatives avant de terminer l’import.'
      end,
      finished_at = now(),
      updated_at = now()
    from stale_jobs
    where jobs.id = stale_jobs.id
    returning jobs.id
  )
  select count(*) into v_reaped from reaped;

  return v_reaped;
end;
$$;

create or replace function public.mark_chapter_import_source_deleted(
  p_job_id uuid
) returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.chapter_import_jobs
  set source_deleted_at = coalesce(source_deleted_at, now()), updated_at = now()
  where id = p_job_id and status in ('completed', 'failed', 'cancelled');
$$;

revoke all on function public.begin_chapter_import(text, text, uuid, bigint, integer, text, text, text, bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.queue_chapter_import(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_chapter_import(text, integer) from public, anon, authenticated;
revoke all on function public.update_chapter_import_progress(uuid, text, integer, jsonb, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_chapter_import(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.fail_chapter_import(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.finalize_chapter_import(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.reap_stale_chapter_imports(integer) from public, anon, authenticated;
revoke all on function public.mark_chapter_import_source_deleted(uuid) from public, anon, authenticated;

grant execute on function public.begin_chapter_import(text, text, uuid, bigint, integer, text, text, text, bigint, integer, integer) to service_role;
grant execute on function public.queue_chapter_import(uuid, uuid) to service_role;
grant execute on function public.claim_chapter_import(text, integer) to service_role;
grant execute on function public.update_chapter_import_progress(uuid, text, integer, jsonb, integer) to service_role;
grant execute on function public.heartbeat_chapter_import(uuid, text, integer) to service_role;
grant execute on function public.fail_chapter_import(uuid, text, text, text, boolean) to service_role;
grant execute on function public.finalize_chapter_import(uuid, text, jsonb) to service_role;
grant execute on function public.reap_stale_chapter_imports(integer) to service_role;
grant execute on function public.mark_chapter_import_source_deleted(uuid) to service_role;

commit;
