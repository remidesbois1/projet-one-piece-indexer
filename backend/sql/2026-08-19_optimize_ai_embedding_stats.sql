begin;

create or replace function public.get_ai_embedding_stats(
  p_manga_slug text default null
) returns table (
  id bigint,
  chapitre_id bigint,
  chapitre_numero integer,
  tome_numero integer,
  numero integer,
  description jsonb,
  has_voyage boolean,
  has_gemini boolean,
  has_f2llm boolean,
  has_description boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p.id,
    p.id_chapitre,
    c.numero,
    t.numero,
    p.numero_page,
    p.description,
    p.embedding_voyage is not null,
    p.embedding_gemini is not null,
    p.embedding_f2llm is not null,
    p.description is not null
      and p.description not in ('null'::jsonb, '""'::jsonb, '{}'::jsonb)
  from public.pages p
  join public.chapitres c on c.id = p.id_chapitre
  join public.tomes t on t.id = c.id_tome
  join public.mangas m on m.id = t.manga_id
  where p_manga_slug is null or m.slug = p_manga_slug
  order by t.numero, c.numero, p.numero_page, p.id;
$$;

revoke all on function public.get_ai_embedding_stats(text) from public, anon, authenticated;
grant execute on function public.get_ai_embedding_stats(text) to service_role;

commit;
