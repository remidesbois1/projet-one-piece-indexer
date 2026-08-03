begin;

revoke all on function public.reorder_bubbles(jsonb) from public;
revoke all on function public.reorder_bubbles(jsonb) from anon;
revoke all on function public.reorder_bubbles(jsonb) from authenticated;
grant execute on function public.reorder_bubbles(jsonb) to service_role;

create or replace function public.reorder_page_bubbles(
  p_page_id bigint,
  p_actor_id uuid,
  p_bubbles jsonb
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role public.role_type;
  v_page_status public.page_status;
  v_input_count integer;
  v_page_count integer;
  v_distinct_ids integer;
  v_distinct_orders integer;
  v_min_order integer;
  v_max_order integer;
  v_updated_count integer;
begin
  if p_page_id is null or p_page_id < 1 or p_actor_id is null then
    raise exception using errcode = '22023', message = 'Page et acteur requis.';
  end if;

  if p_bubbles is null or jsonb_typeof(p_bubbles) <> 'array' then
    raise exception using errcode = '22023', message = 'Liste de bulles invalide.';
  end if;

  v_input_count := jsonb_array_length(p_bubbles);
  if v_input_count < 1 or v_input_count > 2000 then
    raise exception using errcode = '22023', message = 'Nombre de bulles invalide.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_bubbles) as entries(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'id')
       or not (item ? 'order')
       or (select count(*) from jsonb_object_keys(item)) <> 2
       or (item ->> 'id') !~ '^[1-9][0-9]*$'
       or (item ->> 'order') !~ '^[1-9][0-9]*$'
  ) then
    raise exception using errcode = '22023', message = 'Entrée de réordonnancement invalide.';
  end if;

  begin
    with input as (
      select
        (item ->> 'id')::bigint as id,
        (item ->> 'order')::integer as bubble_order
      from jsonb_array_elements(p_bubbles) as entries(item)
    )
    select
      count(distinct id),
      count(distinct bubble_order),
      min(bubble_order),
      max(bubble_order)
    into v_distinct_ids, v_distinct_orders, v_min_order, v_max_order
    from input;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Identifiant ou ordre hors limite.';
  end;

  if v_distinct_ids <> v_input_count
     or v_distinct_orders <> v_input_count
     or v_min_order <> 1
     or v_max_order <> v_input_count then
    raise exception using errcode = '22023', message = 'Identifiants et positions doivent être uniques et contigus.';
  end if;

  select statut
  into v_page_status
  from public.pages
  where id = p_page_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Page introuvable.';
  end if;

  if v_page_status not in ('not_started'::public.page_status, 'in_progress'::public.page_status) then
    raise exception using errcode = '42501', message = 'Cette page ne peut plus être réordonnée.';
  end if;

  select role
  into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if not found then
    raise exception using errcode = '42501', message = 'Profil utilisateur introuvable.';
  end if;

  perform id
  from public.bulles
  where id_page = p_page_id
  order by id
  for update;

  select count(*)
  into v_page_count
  from public.bulles
  where id_page = p_page_id;

  if v_page_count <> v_input_count then
    raise exception using errcode = '22023', message = 'La liste doit contenir toutes les bulles de la page.';
  end if;

  if exists (
    with input as (
      select (item ->> 'id')::bigint as id
      from jsonb_array_elements(p_bubbles) as entries(item)
    )
    select 1
    from input
    left join public.bulles as bubble
      on bubble.id = input.id
     and bubble.id_page = p_page_id
    where bubble.id is null
  ) then
    raise exception using errcode = '22023', message = 'Toutes les bulles doivent appartenir à la même page.';
  end if;

  if v_actor_role not in ('Admin'::public.role_type, 'Modo'::public.role_type)
     and exists (
       select 1
       from public.bulles
       where id_page = p_page_id
         and (
           id_user_createur <> p_actor_id
           or statut <> 'Proposé'::public.statut_bulle
         )
     ) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez réordonner que vos propres bulles non modérées.';
  end if;

  with input as (
    select
      (item ->> 'id')::bigint as id,
      (item ->> 'order')::integer as bubble_order
    from jsonb_array_elements(p_bubbles) as entries(item)
  )
  update public.bulles as bubble
  set "order" = input.bubble_order
  from input
  where bubble.id = input.id
    and bubble.id_page = p_page_id;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_page_count then
    raise exception using errcode = '40001', message = 'Le réordonnancement concurrent doit être réessayé.';
  end if;
end;
$$;

revoke all on function public.reorder_page_bubbles(bigint, uuid, jsonb) from public;
revoke all on function public.reorder_page_bubbles(bigint, uuid, jsonb) from anon;
revoke all on function public.reorder_page_bubbles(bigint, uuid, jsonb) from authenticated;
grant execute on function public.reorder_page_bubbles(bigint, uuid, jsonb) to service_role;

comment on function public.reorder_page_bubbles(bigint, uuid, jsonb) is
  'Atomically validates page state, ownership, membership and a complete contiguous order before updating.';

commit;
