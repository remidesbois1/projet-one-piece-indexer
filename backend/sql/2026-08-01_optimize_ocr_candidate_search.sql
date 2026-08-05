begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create or replace function public.normalize_ocr_search_text(p_value text)
returns text
language sql
immutable
parallel safe
strict
set search_path = pg_catalog
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        translate(
          replace(replace(lower(p_value), 'œ', 'oe'), 'æ', 'ae'),
          'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ',
          'aaaaaaceeeeiiiinooooouuuuyy'
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
$$;

alter table public.bulles
  add column if not exists texte_recherche text
  generated always as (public.normalize_ocr_search_text(texte_propose)) stored;

create index if not exists idx_bulles_validated_texte_recherche_trgm
  on public.bulles using gin (texte_recherche extensions.gin_trgm_ops)
  where statut = 'Validé' and texte_recherche <> '';

alter table public.search_logs
  add column if not exists duration_ocr_candidate_rpc_ms integer,
  add column if not exists duration_ocr_candidate_fetch_ms integer,
  add column if not exists duration_ocr_rank_ms integer,
  add column if not exists ocr_candidate_terms_count integer,
  add column if not exists ocr_candidate_pages_count integer,
  add column if not exists ocr_candidate_cache_hit boolean,
  add column if not exists ocr_budget_exceeded boolean default false;

create or replace function public.search_ocr_page_candidates(
  p_terms jsonb,
  p_manga_slug text default null,
  p_tome_numero integer default null,
  p_characters text[] default null,
  p_arc text default null,
  p_per_term_limit integer default 160,
  p_global_limit integer default 600
) returns table(
  page_id bigint,
  candidate_score double precision,
  matched_terms integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_per_term_limit integer := least(greatest(coalesce(p_per_term_limit, 160), 1), 200);
  v_global_limit integer := least(greatest(coalesce(p_global_limit, 600), 1), 600);
begin
  if p_terms is null or jsonb_typeof(p_terms) <> 'array' then
    raise exception using errcode = '22023', message = 'OCR candidate terms must be an array.';
  end if;

  if jsonb_array_length(p_terms) < 1 or jsonb_array_length(p_terms) > 48 then
    raise exception using errcode = '22023', message = 'OCR candidate term count is out of bounds.';
  end if;

  if p_tome_numero is not null and p_tome_numero < 1 then
    raise exception using errcode = '22023', message = 'Volume number is out of bounds.';
  end if;

  if coalesce(array_length(p_characters, 1), 0) > 32 then
    raise exception using errcode = '22023', message = 'Character filter count is out of bounds.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_terms) as entries(item)
    where jsonb_typeof(item) <> 'object'
       or jsonb_typeof(item -> 'term') <> 'string'
       or jsonb_typeof(item -> 'weight') <> 'number'
       or char_length(public.normalize_ocr_search_text(item ->> 'term')) not between 3 and 80
       or (item ->> 'weight')::double precision <= 0
       or (item ->> 'weight')::double precision > 10
  ) then
    raise exception using errcode = '22023', message = 'OCR candidate term is invalid.';
  end if;

  return query
  with raw_terms as (
    select
      public.normalize_ocr_search_text(item ->> 'term') as term,
      least(greatest((item ->> 'weight')::double precision, 0.05), 10.0) as weight
    from jsonb_array_elements(p_terms) as entries(item)
  ), terms as (
    select raw_terms.term, max(raw_terms.weight) as weight
    from raw_terms
    group by raw_terms.term
  ), per_term_page_matches as (
    select term_matches.page_id, t.term, t.weight, term_matches.similarity
    from terms t
    cross join lateral (
      select page_hits.page_id, max(page_hits.similarity) as similarity
      from (
        select
          b.id_page as page_id,
          case
            when position(' ' || t.term || ' ' in ' ' || b.texte_recherche || ' ') > 0 then 1.0
            else extensions.strict_word_similarity(t.term, b.texte_recherche)::double precision
          end as similarity
        from public.bulles b
        join public.pages p on p.id = b.id_page
        join public.chapitres c on c.id = p.id_chapitre
        join public.tomes v on v.id = c.id_tome
        join public.mangas m on m.id = v.manga_id
        where b.statut = 'Validé'
          and b.texte_recherche <> ''
          and (p_manga_slug is null or m.slug = p_manga_slug)
          and (p_tome_numero is null or v.numero = p_tome_numero)
          and (
            coalesce(array_length(p_characters, 1), 0) = 0
            or (
              jsonb_typeof(p.description #> '{metadata,characters}') = 'array'
              and exists (
                select 1
                from unnest(p_characters) requested(character_name)
                join lateral jsonb_array_elements_text(p.description #> '{metadata,characters}') listed(character_name) on true
                where listed.character_name ilike '%' || requested.character_name || '%'
              )
            )
          )
          and (
            p_arc is null
            or coalesce(p.description #>> '{metadata,arc}', '') ilike '%' || p_arc || '%'
          )
          and (
            (
              char_length(t.term) between 3 and 4
              and position(' ' || t.term || ' ' in ' ' || b.texte_recherche || ' ') > 0
            )
            or (
              char_length(t.term) between 5 and 7
              and t.term operator(extensions.<<%) b.texte_recherche
              and extensions.strict_word_similarity(t.term, b.texte_recherche) >= 0.72
            )
            or (
              char_length(t.term) >= 8
              and t.term operator(extensions.<<%) b.texte_recherche
              and extensions.strict_word_similarity(t.term, b.texte_recherche) >= 0.58
            )
          )
      ) page_hits
      group by page_hits.page_id
      order by max(page_hits.similarity) desc, page_hits.page_id asc
      limit v_per_term_limit
    ) term_matches
  ), scored_pages as (
    select
      matches.page_id,
      sum(matches.weight * matches.similarity)
        + (count(*)::double precision / greatest((select count(*) from terms), 1)) * 0.75 as candidate_score,
      count(*)::integer as matched_terms
    from per_term_page_matches matches
    group by matches.page_id
  )
  select scored.page_id, scored.candidate_score, scored.matched_terms
  from scored_pages scored
  order by scored.candidate_score desc, scored.page_id asc
  limit v_global_limit;
end;
$$;

create or replace function public.get_ocr_search_performance(
  p_window interval default interval '24 hours'
) returns table(
  sample_count bigint,
  total_p50_ms double precision,
  total_p95_ms double precision,
  total_p99_ms double precision,
  rpc_miss_p50_ms double precision,
  rpc_miss_p95_ms double precision,
  rpc_miss_p99_ms double precision,
  cache_hit_rate double precision,
  budget_exceeded_rate double precision,
  error_rate double precision
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    count(*)::bigint,
    percentile_cont(0.50) within group (order by duration_total_ms)::double precision,
    percentile_cont(0.95) within group (order by duration_total_ms)::double precision,
    percentile_cont(0.99) within group (order by duration_total_ms)::double precision,
    percentile_cont(0.50) within group (order by duration_ocr_candidate_rpc_ms)
      filter (where not coalesce(ocr_candidate_cache_hit, false))::double precision,
    percentile_cont(0.95) within group (order by duration_ocr_candidate_rpc_ms)
      filter (where not coalesce(ocr_candidate_cache_hit, false))::double precision,
    percentile_cont(0.99) within group (order by duration_ocr_candidate_rpc_ms)
      filter (where not coalesce(ocr_candidate_cache_hit, false))::double precision,
    coalesce(avg(coalesce(ocr_candidate_cache_hit, false)::integer), 0)::double precision,
    coalesce(avg(coalesce(ocr_budget_exceeded, false)::integer), 0)::double precision,
    coalesce(avg((error is not null)::integer), 0)::double precision
  from public.search_logs
  where search_mode = 'ocr'
    and created_at >= now() - least(greatest(coalesce(p_window, interval '24 hours'), interval '1 minute'), interval '90 days');
$$;

revoke all on function public.search_ocr_page_candidates(jsonb, text, integer, text[], text, integer, integer) from public, anon, authenticated;
revoke all on function public.get_ocr_search_performance(interval) from public, anon, authenticated;
grant execute on function public.search_ocr_page_candidates(jsonb, text, integer, text[], text, integer, integer) to service_role;
grant execute on function public.get_ocr_search_performance(interval) to service_role;

commit;
