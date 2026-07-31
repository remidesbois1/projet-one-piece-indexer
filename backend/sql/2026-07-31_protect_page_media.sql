begin;

-- Page media and contributor metadata must only be read through the backend DTOs.
drop policy if exists "Public read access" on public.pages;
drop policy if exists "Public read access" on public.bulles;

revoke select on table public.pages from anon, authenticated;
revoke select on table public.bulles from anon, authenticated;

-- These legacy RPCs expose the stored page URL. Keep them server-side only.
revoke execute on function public.match_page_embeddings_dinov3(public.vector, integer) from public, anon, authenticated;
revoke execute on function public.match_pages(public.vector, double precision, integer) from public, anon, authenticated;
revoke execute on function public.match_pages_f2llm(public.vector, double precision, integer) from public, anon, authenticated;
revoke execute on function public.match_pages_gemini(public.halfvec, double precision, integer) from public, anon, authenticated;
revoke execute on function public.match_pages_hybrid(public.vector, text, double precision, integer) from public, anon, authenticated;
revoke execute on function public.match_pages_phash(bit, integer, integer) from public, anon, authenticated;
revoke execute on function public.match_pages_visual(public.vector, double precision, integer) from public, anon, authenticated;
revoke execute on function public.match_phash(text, double precision) from public, anon, authenticated;
revoke execute on function public.search_bulles(text) from public, anon, authenticated;
revoke execute on function public.search_bulles(text, integer, integer) from public, anon, authenticated;

grant execute on function public.match_page_embeddings_dinov3(public.vector, integer) to service_role;
grant execute on function public.match_pages(public.vector, double precision, integer) to service_role;
grant execute on function public.match_pages_f2llm(public.vector, double precision, integer) to service_role;
grant execute on function public.match_pages_gemini(public.halfvec, double precision, integer) to service_role;
grant execute on function public.match_pages_hybrid(public.vector, text, double precision, integer) to service_role;
grant execute on function public.match_pages_phash(bit, integer, integer) to service_role;
grant execute on function public.match_pages_visual(public.vector, double precision, integer) to service_role;
grant execute on function public.match_phash(text, double precision) to service_role;
grant execute on function public.search_bulles(text) to service_role;
grant execute on function public.search_bulles(text, integer, integer) to service_role;

-- Defense in depth: even server-side keyword searches only return reviewed bubbles.
create or replace function public.search_bulles(
  search_term text,
  page_limit integer,
  page_offset integer
)
returns table (
  id bigint,
  texte_propose text,
  numero_page integer,
  chapitre_numero integer,
  tome_numero integer,
  url_image text,
  page_id bigint,
  x integer,
  y integer,
  w integer,
  h integer,
  total_count bigint
)
language sql
stable
as $$
  select
    b.id,
    b.texte_propose,
    p.numero_page,
    c.numero as chapitre_numero,
    t.numero as tome_numero,
    p.url_image,
    p.id as page_id,
    b.x,
    b.y,
    b.w,
    b.h,
    count(*) over() as total_count
  from public.bulles b
  join public.pages p on b.id_page = p.id
  join public.chapitres c on p.id_chapitre = c.id
  join public.tomes t on c.id_tome = t.id
  where b.statut = 'Validé'::public.statut_bulle
    and b.texte_propose ilike '%' || search_term || '%'
  order by t.numero, c.numero, p.numero_page, b.id
  limit page_limit
  offset page_offset;
$$;

revoke execute on function public.search_bulles(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_bulles(text, integer, integer) to service_role;

commit;
