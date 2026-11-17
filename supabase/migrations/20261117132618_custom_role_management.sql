create or replace function public.delete_custom_role(
  p_organization_id uuid,
  p_code text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_code text := lower(trim(coalesce(p_code, '')));
  v_is_system boolean;
  v_reassigned_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if p_organization_id is null or v_code = '' then
    raise exception 'INVALID_ROLE';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and p.auth_user_id = auth.uid()
    and coalesce(nullif(p.status, ''), 'active') = 'active'
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  select rd.is_system into v_is_system
  from public.role_definitions rd
  where rd.organization_id = p_organization_id
    and lower(rd.code) = v_code
  limit 1;

  if not found then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  if coalesce(v_is_system, true) then
    raise exception 'SYSTEM_ROLE_LOCKED';
  end if;

  update public.profiles p
  set role = 'member'
  where p.organization_id = p_organization_id
    and lower(coalesce(p.role, 'member')) = v_code;
  get diagnostics v_reassigned_count = row_count;

  delete from public.role_permissions rp
  where rp.organization_id = p_organization_id
    and lower(rp.role_code) = v_code;

  delete from public.role_definitions rd
  where rd.organization_id = p_organization_id
    and lower(rd.code) = v_code;

  return v_reassigned_count;
end;
$$;

revoke all on function public.delete_custom_role(uuid, text) from public;
grant execute on function public.delete_custom_role(uuid, text) to authenticated;
