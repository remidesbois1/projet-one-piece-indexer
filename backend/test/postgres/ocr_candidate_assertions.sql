insert into mangas(slug, titre) values ('one-piece', 'One Piece'), ('other', 'Other');
insert into tomes(numero, manga_id) values (1, 1), (2, 1), (1, 2);
insert into chapitres(id_tome, numero) values (1, 1), (2, 1), (3, 1);
insert into pages(id_chapitre, numero_page, description) values
  (1, 1, '{"metadata":{"characters":["Luffy"],"arc":"East Blue"}}'),
  (1, 2, '{"metadata":{"characters":["Zoro"],"arc":"Alabasta"}}'),
  (2, 1, '{"metadata":{"characters":["Luffy"],"arc":"East Blue"}}'),
  (3, 1, '{"metadata":{"characters":["Luffy"],"arc":"East Blue"}}'),
  (1, 3, '{"metadata":{"characters":["Luffy"],"arc":"East Blue"}}'),
  (1, 4, '{"metadata":{"characters":["Nami"],"arc":"East Blue"}}');
insert into bulles(id_page, texte_propose, statut) values
  (1, 'L’équipage protège le cœur de l’œuvre.', 'Validé'),
  (1, 'Équipage !', 'Validé'),
  (2, 'Un équipage rival approche.', 'Validé'),
  (3, 'L’équipage protège le cœur.', 'Validé'),
  (4, 'L’équipage protège le cœur.', 'Validé'),
  (5, 'Équipage fantôme.', 'Proposé'),
  (6, 'Le capitaine navigue sur Grand Line.', 'Validé');

do $$
begin
  if normalize_ocr_search_text('ÉQUIPAGE, CŒUR, œuvre et Æther') <> 'equipage coeur oeuvre et aether' then
    raise exception 'normalization mismatch: %', normalize_ocr_search_text('ÉQUIPAGE, CŒUR, œuvre et Æther');
  end if;
end $$;

do $$
declare
  v_first bigint;
  v_count integer;
  v_score_one double precision;
  v_score_duplicate double precision;
begin
  select page_id into v_first
  from search_ocr_page_candidates(
    '[{"term":"equipage","weight":1},{"term":"coeur","weight":1}]',
    'one-piece', 1, null, null, 160, 600
  ) order by candidate_score desc, page_id limit 1;
  if v_first <> 1 then raise exception 'coverage ranking failed: %', v_first; end if;

  select count(*) into v_count
  from search_ocr_page_candidates('[{"term":"coeu","weight":1}]', 'one-piece', 1, null, null, 160, 600);
  if v_count <> 0 then raise exception 'short fuzzy term must not match: %', v_count; end if;

  select count(*) into v_count
  from search_ocr_page_candidates('[{"term":"capitainne","weight":1}]', 'one-piece', 1, array['Nami'], 'East Blue', 160, 600)
  where page_id = 6;
  if v_count <> 1 then raise exception 'long fuzzy OCR match failed'; end if;

  select count(*) into v_count
  from search_ocr_page_candidates('[{"term":"equipage","weight":1}]', 'one-piece', 1, array['Luffy'], 'East Blue', 160, 600);
  if v_count <> 1 then raise exception 'metadata filters were not applied before result limiting: %', v_count; end if;

  select candidate_score into v_score_duplicate
  from search_ocr_page_candidates('[{"term":"equipage","weight":1}]', 'one-piece', 1, null, null, 160, 600)
  where page_id = 1;
  select candidate_score into v_score_one
  from search_ocr_page_candidates('[{"term":"equipage","weight":1}]', 'one-piece', 1, null, null, 160, 600)
  where page_id = 2;
  if abs(v_score_duplicate - v_score_one) > 0.000001 then
    raise exception 'duplicate bubbles changed per-term score: % <> %', v_score_duplicate, v_score_one;
  end if;

  select count(*) into v_count
  from search_ocr_page_candidates('[{"term":"equipage","weight":1}]', 'one-piece', 1, null, null, 160, 600)
  where page_id = 5;
  if v_count <> 0 then raise exception 'unvalidated bubble leaked'; end if;

  select count(*) into v_count
  from search_ocr_page_candidates('[{"term":"equipage","weight":1}]', 'other', 1, null, null, 1, 1)
  where page_id = 4;
  if v_count <> 1 then raise exception 'series filter was applied after limit'; end if;
end $$;

do $$
begin
  if has_function_privilege('anon', 'public.search_ocr_page_candidates(jsonb,text,integer,text[],text,integer,integer)', 'execute') then
    raise exception 'anon can execute candidate RPC';
  end if;
  if has_function_privilege('authenticated', 'public.search_ocr_page_candidates(jsonb,text,integer,text[],text,integer,integer)', 'execute') then
    raise exception 'authenticated can execute candidate RPC';
  end if;
  if not has_function_privilege('service_role', 'public.search_ocr_page_candidates(jsonb,text,integer,text[],text,integer,integer)', 'execute') then
    raise exception 'service role cannot execute candidate RPC';
  end if;
end $$;

insert into search_logs(raw_query, model_provider, search_mode, duration_total_ms, duration_ocr_candidate_rpc_ms, ocr_candidate_cache_hit, ocr_budget_exceeded, error)
values
  ('a', 'local', 'ocr', 10, 4, false, false, null),
  ('b', 'local', 'ocr', 20, 8, false, false, null),
  ('c', 'local', 'ocr', 30, 0, true, false, null),
  ('d', 'local', 'ocr', 40, 12, false, true, 'timeout');

do $$
declare r record;
begin
  select * into r from get_ocr_search_performance(interval '1 day');
  if r.sample_count <> 4 or r.total_p50_ms <> 25 or r.total_p95_ms < 38 then
    raise exception 'percentile instrumentation mismatch: %', row_to_json(r);
  end if;
  if abs(r.cache_hit_rate - 0.25) > 0.000001 or abs(r.budget_exceeded_rate - 0.25) > 0.000001 then
    raise exception 'rate instrumentation mismatch: %', row_to_json(r);
  end if;
end $$;

set enable_seqscan = off;
explain (costs off)
select id_page
from bulles
where statut = 'Validé'
  and texte_recherche <> ''
  and 'capitainne' operator(extensions.<<%) texte_recherche;
