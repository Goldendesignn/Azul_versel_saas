-- Azul Gestao V2 - inscricao atomica e reparacao do proprietario M2D.
-- Executar no Supabase de producao.

create or replace function public.validate_license_registration(p_license_key text)
returns table (
  organization_id uuid,
  organization_name text,
  license_key text,
  plan text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license record;
begin
  select
    l.organization_id,
    l.license_key,
    l.plan,
    l.expires_at,
    o.name as organization_name,
    o.status as organization_status
  into v_license
  from public.licenses l
  join public.organizations o on o.id = l.organization_id
  where upper(l.license_key) = upper(trim(coalesce(p_license_key, '')))
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

  return query
  select
    v_license.organization_id,
    v_license.organization_name::text,
    v_license.license_key::text,
    coalesce(v_license.plan, 'starter')::text;
end;
$$;

revoke all on function public.validate_license_registration(text) from public;
grant execute on function public.validate_license_registration(text) to anon, authenticated;

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
set search_path = public, auth
as $$
declare
  v_license record;
  v_auth_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_owner_count integer := 0;
  v_existing record;
  v_role text;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if trim(coalesce(p_license_key, '')) = '' or v_email = '' then
    raise exception 'LICENCA_INVALIDA';
  end if;

  if v_auth_email = '' or v_auth_email <> v_email then
    raise exception 'AUTH_EMAIL_MISMATCH';
  end if;

  select
    l.id as license_id,
    l.organization_id,
    l.license_key,
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
  into v_owner_count
  from public.profiles p
  where p.organization_id = v_license.organization_id
    and coalesce(nullif(p.role, ''), 'member') = 'owner'
    and coalesce(nullif(p.status, ''), 'pending') = 'active';

  select *
  into v_existing
  from public.profiles p
  where p.organization_id = v_license.organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_owner_count = 0 then
    v_role := 'owner';
    v_status := 'active';
  elsif v_existing.id is not null then
    v_role := coalesce(nullif(v_existing.role, ''), 'member');
    v_status := coalesce(nullif(v_existing.status, ''), 'pending');
  else
    v_role := 'member';
    v_status := 'pending';
  end if;

  if v_existing.id is null then
    insert into public.profiles (
      auth_user_id, organization_id, name, phone, email,
      role, status, last_seen_at
    )
    values (
      auth.uid(), v_license.organization_id,
      coalesce(nullif(p_name, ''), v_email),
      coalesce(nullif(p_phone, ''), ''),
      v_email, v_role, v_status, now()
    );
  else
    update public.profiles
    set
      auth_user_id = auth.uid(),
      name = coalesce(nullif(p_name, ''), name, v_email),
      phone = coalesce(nullif(p_phone, ''), phone, ''),
      role = v_role,
      status = v_status,
      last_seen_at = now()
    where id = v_existing.id;
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
    set
      status = 'used',
      used_at = coalesce(used_at, now()),
      activation_count = greatest(coalesce(activation_count, 0), 1)
    where id = v_license.license_id;
  end if;

  return query
  select
    v_license.organization_id,
    coalesce(nullif(p_store_name, ''), v_license.organization_name)::text,
    v_license.license_key::text,
    coalesce(v_license.plan, 'starter')::text,
    v_role,
    v_status;
end;
$$;

revoke all on function public.register_license_access(text, text, text, text, text) from public, anon;
grant execute on function public.register_license_access(text, text, text, text, text) to authenticated;

-- Repare M2D: o email usado na segunda inscricao passa a proprietario.
update public.profiles
set role = 'member', status = 'inactive'
where organization_id = '88b00168-5339-4fef-8fb9-419df83cf3ce'
  and lower(email) = 'mctrdcr1@gmail.com';

update public.profiles
set role = 'owner', status = 'active'
where organization_id = '88b00168-5339-4fef-8fb9-419df83cf3ce'
  and lower(email) = 'mctrdcr244@gmail.com';

update public.organizations
set
  owner_name = 'MOCTAR Doucouré',
  owner_phone = '976196665',
  owner_email = 'mctrdcr244@gmail.com',
  status = 'active'
where id = '88b00168-5339-4fef-8fb9-419df83cf3ce';
