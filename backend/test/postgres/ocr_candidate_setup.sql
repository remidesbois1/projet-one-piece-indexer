create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.mangas (
  id bigint generated always as identity primary key,
  slug text not null,
  titre text not null
);

create table public.tomes (
  id bigint generated always as identity primary key,
  numero integer not null,
  manga_id bigint not null references public.mangas(id)
);

create table public.chapitres (
  id bigint generated always as identity primary key,
  id_tome bigint not null references public.tomes(id),
  numero integer not null
);

create table public.pages (
  id bigint generated always as identity primary key,
  id_chapitre bigint not null references public.chapitres(id),
  numero_page integer not null,
  description jsonb
);

create table public.bulles (
  id bigint generated always as identity primary key,
  id_page bigint not null references public.pages(id),
  texte_propose text,
  statut text not null
);

create table public.search_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  raw_query text not null,
  model_provider text not null,
  search_mode text not null,
  duration_total_ms integer,
  error text
);
