-- Pages without dialogue or text can still be submitted for review.
begin;

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

  update public.pages
  set statut = 'pending_review'::public.page_status
  where id = p_page_id
  returning * into v_after;

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.submit_page_for_review(uuid, bigint) from public, anon, authenticated;
grant execute on function public.submit_page_for_review(uuid, bigint) to service_role;

commit;
