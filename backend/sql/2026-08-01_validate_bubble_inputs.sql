begin;

alter table public.bulles
  add constraint bulles_geometry_is_positive
  check (
    x >= 0
    and y >= 0
    and w between 1 and 100000
    and h between 1 and 100000
    and x <= 100000
    and y <= 100000
  ) not valid;

alter table public.bulles
  add constraint bulles_text_is_bounded
  check (
    texte_propose is not null
    and char_length(btrim(texte_propose)) between 1 and 20000
  ) not valid;

alter table public.bulles
  add constraint bulles_order_is_bounded
  check ("order" is null or "order" between 1 and 2000) not valid;

comment on constraint bulles_geometry_is_positive on public.bulles is
  'Rejects malformed geometry on new writes; image-edge validation remains application-side.';
comment on constraint bulles_text_is_bounded on public.bulles is
  'Rejects empty and oversized proposed text on new writes.';
comment on constraint bulles_order_is_bounded on public.bulles is
  'Caps per-page ordering payloads to the API contract.';

commit;
