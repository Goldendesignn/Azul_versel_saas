drop function if exists public.update_team_member_role_status(uuid, text, text, text);

create or replace function public.update_team_member_role_status(
  p_organization_id uuid,
  p_email text,
  p_role text,
  p_status text
)
returns table (
  email text,
  role text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := lower(trim(coalesce(p_role, 'member')));
  v_status text := lower(trim(coalesce(p_status, 'active')));
  v_active_owner_count integer;
begin
  if p_organization_id is null or v_email = '' then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_role not in ('owner', 'manager', 'cashier', 'stock', 'accountant', 'readonly', 'member') then
    raise exception 'INVALID_ROLE';
  end if;

  if v_status not in ('active', 'pending', 'inactive', 'suspended', 'blocked') then
    raise exception 'INVALID_STATUS';
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
  order by case coalesce(nullif(p.role, ''), 'member')
    when 'owner' then 1
    when 'manager' then 2
    else 9
  end
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_target_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_target_role is null then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_target_role = 'owner' and (v_role <> 'owner' or v_status <> 'active') then
    select count(*)
      into v_active_owner_count
    from public.profiles p
    where p.organization_id = p_organization_id
      and lower(p.email) <> v_email
      and coalesce(nullif(p.role, ''), 'member') = 'owner'
      and coalesce(nullif(p.status, ''), 'active') = 'active';

    if coalesce(v_active_owner_count, 0) < 1 then
      raise exception 'LAST_OWNER_REQUIRED';
    end if;
  end if;

  update public.profiles p
  set
    role = v_role,
    status = v_status,
    last_seen_at = coalesce(p.last_seen_at, now())
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email;

  return query
  select p.email, p.role, p.status
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;
end;
$$;

grant execute on function public.update_team_member_role_status(uuid, text, text, text) to authenticated;

drop function if exists public.delete_team_member(uuid, text);

create or replace function public.delete_team_member(
  p_organization_id uuid,
  p_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_active_owner_count integer;
begin
  if p_organization_id is null or v_email = '' then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
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

  select coalesce(nullif(p.role, ''), 'member')
    into v_target_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_target_role is null then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_target_role = 'owner' then
    select count(*)
      into v_active_owner_count
    from public.profiles p
    where p.organization_id = p_organization_id
      and lower(p.email) <> v_email
      and coalesce(nullif(p.role, ''), 'member') = 'owner'
      and coalesce(nullif(p.status, ''), 'active') = 'active';

    if coalesce(v_active_owner_count, 0) < 1 then
      raise exception 'LAST_OWNER_REQUIRED';
    end if;
  end if;

  delete from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email;
end;
$$;

grant execute on function public.delete_team_member(uuid, text) to authenticated;
