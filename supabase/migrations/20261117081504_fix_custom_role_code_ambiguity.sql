create or replace function public.upsert_custom_role(
  p_organization_id uuid,
  p_code text,
  p_name text,
  p_permissions text[]
)
returns table (
  code text,
  name text,
  permissions text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_code text := lower(regexp_replace(trim(coalesce(p_code, '')), '[^a-z0-9_]+', '_', 'g'));
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if p_organization_id is null or v_code = '' or trim(coalesce(p_name, '')) = '' then
    raise exception 'INVALID_ROLE';
  end if;

  if v_code in ('owner', 'manager', 'cashier', 'stock', 'accountant', 'readonly', 'member') then
    raise exception 'SYSTEM_ROLE_LOCKED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.status, ''), 'active') = 'active'
    and (
      p.auth_user_id = auth.uid()
      or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  update public.role_definitions as rd
  set
    name = trim(p_name),
    description = 'Role personalizado',
    is_system = false
  where rd.organization_id = p_organization_id
    and lower(rd.code) = v_code;

  if not found then
    insert into public.role_definitions (organization_id, code, name, description, is_system)
    values (p_organization_id, v_code, trim(p_name), 'Role personalizado', false);
  end if;

  delete from public.role_permissions
  where organization_id = p_organization_id
    and lower(role_code) = v_code;

  insert into public.role_permissions (organization_id, role_code, permission)
  select p_organization_id, v_code, distinct_permission
  from (
    select distinct unnest(coalesce(p_permissions, array[]::text[])) as distinct_permission
  ) permissions_source
  where trim(coalesce(distinct_permission, '')) <> '';

  return query
  select v_code, trim(p_name), coalesce(p_permissions, array[]::text[]);
end;
$$;

revoke all on function public.upsert_custom_role(uuid, text, text, text[]) from public;
grant execute on function public.upsert_custom_role(uuid, text, text, text[]) to authenticated;
