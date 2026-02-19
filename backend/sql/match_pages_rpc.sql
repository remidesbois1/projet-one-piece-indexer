create or replace function match_pages(
  query_embedding vector(1024),
  match_threshold float default 0.30,
  match_count int default 50
)
returns table (
  id bigint,
  url_image text,
  description jsonb,
  numero_page int,
  chapitre_numero int,
  tome_numero int,
  id_tome bigint,
  manga_slug text,
  similarity float
)
language sql stable
as $$
  select
    p.id,
    p.url_image,
    p.description::jsonb,
    p.numero_page,
    c.numero as chapitre_numero,
    t.numero as tome_numero,
    c.id_tome,
    m.slug as manga_slug,
    1 - (p.embedding_voyage <=> query_embedding) as similarity
  from pages p
  join chapitres c on c.id = p.id_chapitre
  join tomes t on t.id = c.id_tome
  join mangas m on m.id = t.manga_id
  where p.embedding_voyage is not null
    and 1 - (p.embedding_voyage <=> query_embedding) > match_threshold
  order by p.embedding_voyage <=> query_embedding
  limit match_count;
$$;
