begin;

create or replace function public.can_edit_bubble(
  p_actor_id uuid,
  p_bubble_id bigint,
  p_page_id bigint default null
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with actor as (
    select role
    from public.profiles
    where id = p_actor_id
  ), target as (
    select
      page.id as page_id,
      page.statut as page_status,
      bubble.id as bubble_id,
      bubble.id_user_createur,
      bubble.statut as bubble_status
    from public.pages as page
    left join public.bulles as bubble
      on bubble.id = p_bubble_id
     and bubble.id_page = page.id
    where page.id = coalesce(p_page_id, bubble.id_page)
  )
  select coalesce(bool_or(
    case
      when target.bubble_id is null and p_bubble_id is null then
        target.page_status in (
          'not_started'::public.page_status,
          'in_progress'::public.page_status
        )
      when target.bubble_status is distinct from 'Proposé'::public.statut_bulle then false
      when actor.role in ('Admin'::public.role_type, 'Modo'::public.role_type) then
        target.page_status in (
          'not_started'::public.page_status,
          'in_progress'::public.page_status,
          'pending_review'::public.page_status
        )
      else
        target.id_user_createur = p_actor_id
        and target.page_status in (
          'not_started'::public.page_status,
          'in_progress'::public.page_status
        )
    end
  ), false)
  from actor
  cross join target;
$$;

revoke all on function public.can_edit_bubble(uuid, bigint, bigint) from public;
revoke all on function public.can_edit_bubble(uuid, bigint, bigint) from anon;
revoke all on function public.can_edit_bubble(uuid, bigint, bigint) from authenticated;
grant execute on function public.can_edit_bubble(uuid, bigint, bigint) to service_role;

create or replace function public.guard_bubble_content_mutations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_status public.page_status;
  v_content_changed boolean;
  v_terminal_changed boolean;
begin
  if tg_op = 'INSERT' then
    select statut
    into v_page_status
    from public.pages
    where id = new.id_page
    for key share;

    if not found then
      raise exception using errcode = 'P0002', message = 'Page introuvable.';
    end if;
    if v_page_status not in (
      'not_started'::public.page_status,
      'in_progress'::public.page_status
    ) then
      raise exception using errcode = '55000', message = 'Cette page ne peut plus recevoir de bulles.';
    end if;
    return new;
  end if;

  if old.id_page is distinct from new.id_page
     or old.id_user_createur is distinct from new.id_user_createur then
    raise exception using errcode = '42501', message = 'La page et le créateur d’une bulle sont immuables.';
  end if;

  v_content_changed := row(
    old.x, old.y, old.w, old.h, old.texte_ocr_brut, old.texte_propose, old."order"
  ) is distinct from row(
    new.x, new.y, new.w, new.h, new.texte_ocr_brut, new.texte_propose, new."order"
  );

  v_terminal_changed := row(
    old.x, old.y, old.w, old.h, old.texte_ocr_brut, old.texte_propose,
    old."order", old.statut, old.validated_at, old.commentaire_moderation
  ) is distinct from row(
    new.x, new.y, new.w, new.h, new.texte_ocr_brut, new.texte_propose,
    new."order", new.statut, new.validated_at, new.commentaire_moderation
  );

  if old.statut in (
    'Validé'::public.statut_bulle,
    'Rejeté'::public.statut_bulle
  ) and v_terminal_changed then
    raise exception using errcode = '55000', message = 'Une bulle modérée est immuable.';
  end if;

  if v_content_changed then
    if old.statut is distinct from 'Proposé'::public.statut_bulle
       or new.statut is distinct from old.statut then
      raise exception using errcode = '55000', message = 'Une bulle doit être proposée pour être modifiée.';
    end if;

    select statut
    into v_page_status
    from public.pages
    where id = old.id_page
    for key share;

    if not found then
      raise exception using errcode = 'P0002', message = 'Page introuvable.';
    end if;
    if v_page_status not in (
      'not_started'::public.page_status,
      'in_progress'::public.page_status,
      'pending_review'::public.page_status
    ) then
      raise exception using errcode = '55000', message = 'Le contenu d’une page terminée est immuable.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_bubble_content_mutations on public.bulles;
create trigger guard_bubble_content_mutations
before insert or update on public.bulles
for each row execute function public.guard_bubble_content_mutations();

create or replace function public.create_editable_bubble(
  p_actor_id uuid,
  p_page_id bigint,
  p_x integer,
  p_y integer,
  p_w integer,
  p_h integer,
  p_text text,
  p_order integer default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page public.pages%rowtype;
  v_order integer;
  v_created public.bulles%rowtype;
begin
  select * into v_page
  from public.pages
  where id = p_page_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Page introuvable.';
  end if;
  if not public.can_edit_bubble(p_actor_id, null, p_page_id) then
    if v_page.statut not in (
      'not_started'::public.page_status,
      'in_progress'::public.page_status
    ) then
      raise exception using errcode = '55000', message = 'Cette page ne peut plus recevoir de bulles.';
    end if;
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas annoter cette page.';
  end if;

  if p_order is null then
    select coalesce(max("order"), 0) + 1
    into v_order
    from public.bulles
    where id_page = p_page_id;
  else
    v_order := p_order;
  end if;

  if v_order < 1 or v_order > 2000 then
    raise exception using errcode = '22023', message = 'Ordre de bulle invalide.';
  end if;

  insert into public.bulles (
    id_page, id_user_createur, x, y, w, h, texte_propose, statut, "order"
  ) values (
    p_page_id, p_actor_id, p_x, p_y, p_w, p_h, p_text,
    'Proposé'::public.statut_bulle, v_order
  )
  returning * into v_created;

  update public.pages
  set statut = 'in_progress'::public.page_status
  where id = p_page_id
    and statut = 'not_started'::public.page_status;

  return jsonb_build_object('after', to_jsonb(v_created));
end;
$$;

create or replace function public.update_editable_bubble(
  p_actor_id uuid,
  p_bubble_id bigint,
  p_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_id bigint;
  v_page public.pages%rowtype;
  v_before public.bulles%rowtype;
  v_after public.bulles%rowtype;
begin
  if p_patch is null
     or jsonb_typeof(p_patch) <> 'object'
     or p_patch = '{}'::jsonb
     or exists (
       select 1
       from jsonb_object_keys(p_patch) as keys(key)
       where key not in ('x', 'y', 'w', 'h', 'texte_propose')
     ) then
    raise exception using errcode = '22023', message = 'Modification de bulle invalide.';
  end if;

  select id_page into v_page_id
  from public.bulles
  where id = p_bubble_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Bulle introuvable.';
  end if;

  select * into v_page
  from public.pages
  where id = v_page_id
  for update;

  select * into v_before
  from public.bulles
  where id = p_bubble_id
    and id_page = v_page_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Bulle introuvable.';
  end if;
  if v_before.statut is distinct from 'Proposé'::public.statut_bulle then
    raise exception using errcode = '55000', message = 'Une bulle modérée est immuable.';
  end if;
  if not public.can_edit_bubble(p_actor_id, p_bubble_id, v_page_id) then
    if v_page.statut = 'completed'::public.page_status then
      raise exception using errcode = '55000', message = 'Le contenu d’une page terminée est immuable.';
    end if;
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier cette bulle.';
  end if;

  update public.bulles
  set
    x = case when p_patch ? 'x' then (p_patch ->> 'x')::integer else x end,
    y = case when p_patch ? 'y' then (p_patch ->> 'y')::integer else y end,
    w = case when p_patch ? 'w' then (p_patch ->> 'w')::integer else w end,
    h = case when p_patch ? 'h' then (p_patch ->> 'h')::integer else h end,
    texte_propose = case
      when p_patch ? 'texte_propose' then p_patch ->> 'texte_propose'
      else texte_propose
    end
  where id = p_bubble_id
  returning * into v_after;

  return jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after));
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'Valeur de bulle invalide.';
end;
$$;

create or replace function public.delete_editable_bubble(
  p_actor_id uuid,
  p_bubble_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role public.role_type;
  v_page_id bigint;
  v_page public.pages%rowtype;
  v_before public.bulles%rowtype;
begin
  select id_page into v_page_id
  from public.bulles
  where id = p_bubble_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Bulle introuvable.';
  end if;

  select * into v_page
  from public.pages
  where id = v_page_id
  for update;

  select * into v_before
  from public.bulles
  where id = p_bubble_id
    and id_page = v_page_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Bulle introuvable.';
  end if;

  select role into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if not found then
    raise exception using errcode = '42501', message = 'Profil utilisateur introuvable.';
  end if;

  if v_actor_role <> 'Admin'::public.role_type then
    if v_before.id_user_createur <> p_actor_id
       or not public.can_edit_bubble(p_actor_id, p_bubble_id, v_page_id) then
      if v_before.statut is distinct from 'Proposé'::public.statut_bulle
         or v_page.statut = 'completed'::public.page_status then
        raise exception using errcode = '55000', message = 'Cette bulle ne peut plus être supprimée.';
      end if;
      raise exception using errcode = '42501', message = 'Vous ne pouvez pas supprimer cette bulle.';
    end if;
  end if;

  delete from public.bulles
  where id = p_bubble_id;

  return jsonb_build_object('before', to_jsonb(v_before));
end;
$$;

create or replace function public.moderate_proposed_bubble(
  p_actor_id uuid,
  p_bubble_id bigint,
  p_decision text,
  p_comment text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role public.role_type;
  v_before public.bulles%rowtype;
  v_after public.bulles%rowtype;
begin
  select role into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if not found or v_actor_role not in ('Admin'::public.role_type, 'Modo'::public.role_type) then
    raise exception using errcode = '42501', message = 'Droits de modération insuffisants.';
  end if;
  if p_decision not in ('validate', 'reject') then
    raise exception using errcode = '22023', message = 'Décision de modération invalide.';
  end if;

  select * into v_before
  from public.bulles
  where id = p_bubble_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Bulle introuvable.';
  end if;
  if v_before.statut is distinct from 'Proposé'::public.statut_bulle then
    raise exception using errcode = '55000', message = 'Cette bulle a déjà été modérée.';
  end if;

  update public.bulles
  set
    statut = case
      when p_decision = 'validate' then 'Validé'::public.statut_bulle
      else 'Rejeté'::public.statut_bulle
    end,
    validated_at = case when p_decision = 'validate' then now() else null end,
    commentaire_moderation = case when p_decision = 'reject' then p_comment else null end
  where id = p_bubble_id
  returning * into v_after;

  return jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after));
end;
$$;

create or replace function public.submit_page_for_review(
  p_actor_id uuid,
  p_page_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role public.role_type;
  v_page public.pages%rowtype;
  v_after public.pages%rowtype;
  v_bubble_count integer;
begin
  select role into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if not found or v_actor_role not in ('Admin'::public.role_type, 'Modo'::public.role_type) then
    raise exception using errcode = '42501', message = 'Seul le staff peut soumettre une page.';
  end if;

  select * into v_page
  from public.pages
  where id = p_page_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Page introuvable.';
  end if;
  if v_page.statut not in (
    'not_started'::public.page_status,
    'in_progress'::public.page_status
  ) then
    raise exception using errcode = '55000', message = 'Cette page ne peut pas être soumise.';
  end if;

  select count(*) into v_bubble_count
  from public.bulles
  where id_page = p_page_id;

  if v_bubble_count < 1 then
    raise exception using errcode = '55000', message = 'Ajoutez au moins une bulle avant la soumission.';
  end if;

  update public.pages
  set statut = 'pending_review'::public.page_status
  where id = p_page_id
  returning * into v_after;

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.create_editable_bubble(uuid, bigint, integer, integer, integer, integer, text, integer) from public, anon, authenticated;
revoke all on function public.update_editable_bubble(uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.delete_editable_bubble(uuid, bigint) from public, anon, authenticated;
revoke all on function public.moderate_proposed_bubble(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.submit_page_for_review(uuid, bigint) from public, anon, authenticated;

grant execute on function public.create_editable_bubble(uuid, bigint, integer, integer, integer, integer, text, integer) to service_role;
grant execute on function public.update_editable_bubble(uuid, bigint, jsonb) to service_role;
grant execute on function public.delete_editable_bubble(uuid, bigint) to service_role;
grant execute on function public.moderate_proposed_bubble(uuid, bigint, text, text) to service_role;
grant execute on function public.submit_page_for_review(uuid, bigint) to service_role;

drop policy if exists "Authenticated insert" on public.bulles;
create policy "Authenticated insert" on public.bulles
for insert
with check (
  auth.role() = 'authenticated'::text
  and auth.uid() = id_user_createur
  and exists (
    select 1
    from public.pages
    where pages.id = bulles.id_page
      and pages.statut in (
        'not_started'::public.page_status,
        'in_progress'::public.page_status
      )
  )
);

drop policy if exists "Users update own pending bubbles" on public.bulles;
create policy "Users update own pending bubbles" on public.bulles
for update
using (
  auth.uid() = id_user_createur
  and statut = 'Proposé'::public.statut_bulle
  and exists (
    select 1
    from public.pages
    where pages.id = bulles.id_page
      and pages.statut in (
        'not_started'::public.page_status,
        'in_progress'::public.page_status
      )
  )
)
with check (
  auth.uid() = id_user_createur
  and statut = 'Proposé'::public.statut_bulle
  and exists (
    select 1
    from public.pages
    where pages.id = bulles.id_page
      and pages.statut in (
        'not_started'::public.page_status,
        'in_progress'::public.page_status
      )
  )
);

drop policy if exists "Users delete own pending bubbles" on public.bulles;
create policy "Users delete own pending bubbles" on public.bulles
for delete
using (
  auth.uid() = id_user_createur
  and statut = 'Proposé'::public.statut_bulle
  and exists (
    select 1
    from public.pages
    where pages.id = bulles.id_page
      and pages.statut in (
        'not_started'::public.page_status,
        'in_progress'::public.page_status
      )
  )
);

commit;
