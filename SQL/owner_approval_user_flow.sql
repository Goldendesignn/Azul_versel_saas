alter table public.profiles
  add column if not exists role text,
  add column if not exists status text,
  add column if not exists auth_user_id uuid,
  add column if not exists last_seen_at timestamp with time zone,
  add column if not exists created_at timestamp with time zone default now();

with ranked_profiles as (
  select
    p.organization_id,
    lower(p.email) as email_key,
    row_number() over (
      partition by p.organization_id
      order by coalesce(p.created_at, p.last_seen_at, now()) asc, lower(p.email) asc
    ) as position_in_org,
    coalesce(nullif(p.role, ''), 'member') as current_role
  from public.profiles p
  where p.organization_id is not null
    and p.email is not null
    and trim(p.email) <> ''
)
update public.profiles p
set
  role = case
    when r.position_in_org = 1 then 'owner'
    when r.current_role = 'owner' then 'member'
    else coalesce(nullif(p.role, ''), 'member')
  end,
  status = case
    when r.position_in_org = 1 then 'active'
    when r.current_role = 'owner' then 'pending'
    else coalesce(nullif(p.status, ''), 'pending')
  end
from ranked_profiles r
where p.organization_id = r.organization_id
  and lower(p.email) = r.email_key
  and (
    r.position_in_org = 1
    or r.current_role = 'owner'
    or p.role is null
    or trim(p.role) = ''
    or p.status is null
    or trim(p.status) = ''
  );

update public.profiles
set role = 'member'
where role is null or trim(role) = '';

update public.profiles
set status = 'pending'
where status is null or trim(status) = '';

create index if not exists profiles_org_email_idx
  on public.profiles (organization_id, lower(email));

drop function if exists public.get_login_profile_v2(text);

create or replace function public.get_login_profile_v2(p_identifier text)
returns table (
  organization_id uuid,
  name text,
  email text,
  phone text,
  role text,
  status text
)
language sql
security definer
set search_path = public
as $$
  select
    p.organization_id,
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'pending') as status
  from public.profiles p
  where lower(p.email) = lower(trim(coalesce(p_identifier, '')))
    or regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') = regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g')
  order by
    case coalesce(nullif(p.status, ''), 'pending')
      when 'active' then 1
      when 'pending' then 2
      else 3
    end,
    p.last_seen_at desc nulls last
  limit 1;
$$;

grant execute on function public.get_login_profile_v2(text) to anon, authenticated;

drop function if exists public.get_login_profile_for_org(uuid, text);

create or replace function public.get_login_profile_for_org(
  p_organization_id uuid,
  p_identifier text
)
returns table (
  organization_id uuid,
  name text,
  email text,
  phone text,
  role text,
  status text
)
language sql
security definer
set search_path = public
as $$
  select
    p.organization_id,
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'pending') as status
  from public.profiles p
  where p.organization_id = p_organization_id
    and (
      lower(p.email) = lower(trim(coalesce(p_identifier, '')))
      or regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') =
         regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g')
    )
  limit 1;
$$;

grant execute on function public.get_login_profile_for_org(uuid, text) to anon, authenticated;

drop function if exists public.register_license_access(text, text, text, text, text);

create or replace function public.register_license_access(
  p_license_key text,
  p_store_name text,
  p_name text,
  p_phone text,
  p_email text
)
returns table (
  organization_id uuid,
  organization_name text,
  license_key text,
  plan text,
  role text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license record;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_profile_count integer := 0;
  v_existing record;
  v_role text;
  v_status text;
begin
  if trim(coalesce(p_license_key, '')) = '' or v_email = '' then
    raise exception 'LICENCA_INVALIDA';
  end if;

  select
    l.id as license_id,
    l.organization_id,
    l.license_key,
    l.status as license_status,
    l.plan,
    l.expires_at,
    o.name as organization_name,
    o.status as organization_status
  into v_license
  from public.licenses l
  join public.organizations o on o.id = l.organization_id
  where upper(l.license_key) = upper(trim(p_license_key))
  limit 1;

  if v_license.organization_id is null then
    raise exception 'LICENCA_INVALIDA';
  end if;

  if v_license.expires_at is not null and v_license.expires_at < now() then
    raise exception 'LICENCA_EXPIRADA';
  end if;

  if coalesce(v_license.organization_status, 'pending') in ('suspended', 'blocked', 'inactive') then
    raise exception 'LICENCA_INATIVA';
  end if;

  select count(*)
    into v_profile_count
  from public.profiles p
  where p.organization_id = v_license.organization_id;

  select *
    into v_existing
  from public.profiles p
  where p.organization_id = v_license.organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_profile_count = 0 then
    v_role := 'owner';
    v_status := 'active';
  else
    v_role := coalesce(nullif(v_existing.role, ''), 'member');
    v_status := coalesce(nullif(v_existing.status, ''), 'pending');

    if v_existing.email is null then
      v_role := 'member';
      v_status := 'pending';
    end if;
  end if;

  if v_role = 'owner' and v_status = 'active' then
    update public.organizations
    set
      name = coalesce(nullif(p_store_name, ''), name),
      status = 'active',
      owner_name = coalesce(nullif(p_name, ''), owner_name),
      owner_phone = coalesce(nullif(p_phone, ''), owner_phone),
      owner_email = v_email
    where id = v_license.organization_id;

    update public.licenses
    set status = 'used',
        used_at = coalesce(used_at, now())
    where id = v_license.license_id;
  end if;

  if v_existing.email is null then
    insert into public.profiles (
      organization_id,
      name,
      phone,
      email,
      role,
      status,
      last_seen_at
    )
    values (
      v_license.organization_id,
      coalesce(nullif(p_name, ''), v_email),
      coalesce(nullif(p_phone, ''), ''),
      v_email,
      v_role,
      v_status,
      now()
    );
  else
    update public.profiles
    set
      name = coalesce(nullif(p_name, ''), name, v_email),
      phone = coalesce(nullif(p_phone, ''), phone, ''),
      role = v_role,
      status = v_status,
      last_seen_at = now()
    where organization_id = v_license.organization_id
      and lower(email) = v_email;
  end if;

  return query
  select
    v_license.organization_id,
    coalesce(nullif(p_store_name, ''), v_license.organization_name),
    v_license.license_key,
    coalesce(v_license.plan, 'starter'),
    v_role,
    v_status;
end;
$$;

grant execute on function public.register_license_access(text, text, text, text, text) to anon, authenticated;

drop function if exists public.touch_team_user(uuid, text, text, text, text);

create or replace function public.touch_team_user(
  p_organization_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_role text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(nullif(p_email, ''), auth.jwt() ->> 'email', ''));
begin
  if p_organization_id is null or v_email is null or trim(v_email) = '' then
    return;
  end if;

  update public.profiles
  set
    auth_user_id = coalesce(auth_user_id, auth.uid()),
    name = coalesce(nullif(p_name, ''), name, email),
    phone = coalesce(nullif(p_phone, ''), phone, ''),
    last_seen_at = now()
  where organization_id = p_organization_id
    and lower(email) = v_email
    and coalesce(nullif(status, ''), 'pending') = 'active';
end;
$$;

grant execute on function public.touch_team_user(uuid, text, text, text, text) to authenticated;
