-- Azul Gestao V2 - correcao de acesso, primeiro proprietario e contadores admin.
-- Executar uma vez no Supabase de producao depois de supabase_remote_functions.sql.

update public.licenses
set activation_count = greatest(coalesce(activation_count, 0), 1)
where status in ('used', 'active');

create or replace function public.ensure_first_owner_profile(
  p_organization_id uuid
)
returns table (
  organization_id uuid,
  name text,
  email text,
  phone text,
  role text,
  status text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_profile_id uuid;
  v_owner_count integer;
begin
  if v_user_id is null or p_organization_id is null or v_email = '' then
    raise exception 'AUTH_REQUIRED';
  end if;

  select p.id
    into v_profile_id
  from public.profiles p
  where p.organization_id = p_organization_id
    and (
      p.auth_user_id = v_user_id
      or lower(p.email) = v_email
    )
  order by p.created_at
  limit 1;

  if v_profile_id is null then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  select count(*)
    into v_owner_count
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.role, ''), 'member') = 'owner'
    and coalesce(nullif(p.status, ''), 'pending') = 'active';

  update public.profiles p
  set
    auth_user_id = coalesce(p.auth_user_id, v_user_id),
    role = case when v_owner_count = 0 then 'owner' else p.role end,
    status = case when v_owner_count = 0 then 'active' else p.status end,
    last_seen_at = now()
  where p.id = v_profile_id;

  if v_owner_count = 0 then
    update public.organizations
    set status = 'active'
    where id = p_organization_id;

    update public.licenses
    set
      status = 'used',
      used_at = coalesce(used_at, now()),
      activation_count = greatest(coalesce(activation_count, 0), 1)
    where organization_id = p_organization_id
      and status in ('unused', 'active', 'used');
  end if;

  return query
  select
    p.organization_id,
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member'),
    coalesce(nullif(p.status, ''), 'pending')
  from public.profiles p
  where p.id = v_profile_id;
end;
$$;

revoke all on function public.ensure_first_owner_profile(uuid) from public, anon;
grant execute on function public.ensure_first_owner_profile(uuid) to authenticated;

create or replace function public.admin_list_clients()
returns table (
  id uuid,
  name text,
  phone text,
  email text,
  status text,
  plan text,
  created_at timestamp with time zone,
  expires_at timestamp with time zone,
  current_license_key text,
  current_license_status text,
  activation_count integer,
  activation_limit integer,
  active_devices integer,
  device_limit integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED';
  end if;

  return query
  select
    o.id,
    coalesce(o.name, o.owner_name, 'Cliente')::text,
    o.owner_phone::text,
    o.owner_email::text,
    o.status::text,
    coalesce(o.plan, 'starter')::text,
    o.created_at,
    l.expires_at,
    l.license_key::text,
    l.status::text,
    coalesce(l.activation_count, 0)::integer,
    coalesce(l.activation_limit, 1)::integer,
    coalesce(d.active_devices, 0)::integer,
    coalesce(o.device_limit, 1)::integer
  from public.organizations o
  left join lateral (
    select li.*
    from public.licenses li
    where li.organization_id = o.id
    order by li.created_at desc
    limit 1
  ) l on true
  left join lateral (
    select count(*)::integer as active_devices
    from public.organization_devices od
    where od.organization_id = o.id
      and od.active = true
  ) d on true
  order by o.created_at desc;
end;
$$;

revoke all on function public.admin_list_clients() from public, anon;
grant execute on function public.admin_list_clients() to authenticated;

drop function if exists public.admin_list_clients_v2();

create function public.admin_list_clients_v2()
returns table (
  id uuid,
  name text,
  phone text,
  email text,
  status text,
  plan text,
  created_at timestamp with time zone,
  expires_at timestamp with time zone,
  current_license_key text,
  current_license_status text,
  activation_count integer,
  activation_limit integer,
  active_devices integer,
  device_limit integer,
  total_users integer,
  active_users integer,
  pending_users integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED';
  end if;

  return query
  select
    o.id,
    coalesce(o.name, o.owner_name, 'Cliente')::text,
    o.owner_phone::text,
    o.owner_email::text,
    o.status::text,
    coalesce(o.plan, 'starter')::text,
    o.created_at,
    l.expires_at,
    l.license_key::text,
    l.status::text,
    coalesce(l.activation_count, 0)::integer,
    coalesce(l.activation_limit, 1)::integer,
    coalesce(d.active_devices, 0)::integer,
    coalesce(o.device_limit, 1)::integer,
    coalesce(u.total_users, 0)::integer,
    coalesce(u.active_users, 0)::integer,
    coalesce(u.pending_users, 0)::integer
  from public.organizations o
  left join lateral (
    select li.*
    from public.licenses li
    where li.organization_id = o.id
    order by li.created_at desc
    limit 1
  ) l on true
  left join lateral (
    select count(*)::integer as active_devices
    from public.organization_devices od
    where od.organization_id = o.id
      and od.active = true
  ) d on true
  left join lateral (
    select
      count(*)::integer as total_users,
      count(*) filter (where coalesce(nullif(p.status, ''), 'pending') = 'active')::integer as active_users,
      count(*) filter (where coalesce(nullif(p.status, ''), 'pending') = 'pending')::integer as pending_users
    from public.profiles p
    where p.organization_id = o.id
  ) u on true
  order by o.created_at desc;
end;
$$;

revoke all on function public.admin_list_clients_v2() from public, anon;
grant execute on function public.admin_list_clients_v2() to authenticated;
