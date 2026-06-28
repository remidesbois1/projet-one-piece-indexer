alter table public.pages
add column if not exists embedding_f2llm public.vector(640);

create index if not exists pages_embedding_f2llm_idx
on public.pages
using hnsw (embedding_f2llm public.vector_cosine_ops);

create or replace function public.match_pages_f2llm(
  query_embedding public.vector,
  match_threshold double precision default 0.30,
  match_count integer default 50
)
returns table (
  id bigint,
  url_image text,
  description jsonb,
  numero_page integer,
  chapitre_numero integer,
  tome_numero integer,
  id_tome bigint,
  manga_slug text,
  similarity double precision
)
language sql
stable
as $$
  select
    p.id,
    p.url_image,
    p.description,
    p.numero_page,
    c.numero as chapitre_numero,
    t.numero as tome_numero,
    c.id_tome,
    m.slug as manga_slug,
    1 - (p.embedding_f2llm <=> query_embedding) as similarity
  from public.pages p
  join public.chapitres c on c.id = p.id_chapitre
  join public.tomes t on t.id = c.id_tome
  join public.mangas m on m.id = t.manga_id
  where p.embedding_f2llm is not null
    and 1 - (p.embedding_f2llm <=> query_embedding) > match_threshold
  order by p.embedding_f2llm <=> query_embedding
  limit match_count;
$$;

grant all on function public.match_pages_f2llm(public.vector, double precision, integer)
to anon, authenticated, service_role;
