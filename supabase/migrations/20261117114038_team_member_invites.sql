create table if not exists public.team_access_invitations (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  name text not null,
  phone text not null default '',
  role text not null default 'cashier',
  access_code_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'used', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  primary key (organization_id, email)
);

create index if not exists team_access_invitations_email_pending_idx
  on public.team_access_invitations (lower(email), expires_at desc)
  where status = 'pending';

alter table public.team_access_invitations enable row level security;
revoke all on public.team_access_invitations from anon, authenticated;

create or replace function public.create_team_access_invitation(
  p_organization_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_role text,
  p_access_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := lower(trim(coalesce(p_role, 'cashier')));
  v_role_exists boolean;
  v_existing_profile public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if p_organization_id is null or trim(coalesce(p_name, '')) = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'DADOS_CONVITE_INVALIDOS';
  end if;

  if coalesce(p_access_code, '') !~ '^[0-9]{8}$' then
    raise exception 'CODIGO_CONVITE_INVALIDO';
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

  select exists (
    select 1
    from public.role_definitions rd
    where lower(rd.code) = v_role
      and (rd.organization_id is null or rd.organization_id = p_organization_id)
      and lower(rd.code) not in ('owner', 'manager')
  ) into v_role_exists;

  if not coalesce(v_role_exists, false) then
    raise exception 'INVALID_ROLE';
  end if;

  select * into v_existing_profile
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_existing_profile.auth_user_id is not null and coalesce(nullif(v_existing_profile.status, ''), 'active') = 'active' then
    raise exception 'TEAM_MEMBER_ALREADY_ACTIVE';
  end if;

  update public.profiles p
  set name = trim(p_name),
      phone = trim(coalesce(p_phone, '')),
      role = v_role,
      status = case when p.auth_user_id is null then 'pending' else p.status end
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email;

  if not found then
    insert into public.profiles (organization_id, name, phone, email, role, status, last_seen_at)
    values (p_organization_id, trim(p_name), trim(coalesce(p_phone, '')), v_email, v_role, 'pending', now());
  end if;

  insert into public.team_access_invitations (
    organization_id, email, name, phone, role, access_code_hash, status, expires_at, created_by, created_at, used_at
  ) values (
    p_organization_id, v_email, trim(p_name), trim(coalesce(p_phone, '')), v_role,
    extensions.crypt(p_access_code, extensions.gen_salt('bf', 10)), 'pending', now() + interval '7 days', auth.uid(), now(), null
  ) on conflict (organization_id, email) do update
  set name = excluded.name,
      phone = excluded.phone,
      role = excluded.role,
      access_code_hash = excluded.access_code_hash,
      status = 'pending',
      expires_at = now() + interval '7 days',
      created_by = auth.uid(),
      created_at = now(),
      used_at = null;
end;
$$;

revoke all on function public.create_team_access_invitation(uuid, text, text, text, text, text) from public;
grant execute on function public.create_team_access_invitation(uuid, text, text, text, text, text) to authenticated;

create or replace function public.activate_team_access_invitation(
  p_email text,
  p_access_code text
)
returns table (
  organization_id uuid,
  name text,
  phone text,
  role text,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_invitation public.team_access_invitations%rowtype;
  v_found boolean := false;
begin
  if auth.uid() is null or v_email = '' or lower(coalesce(auth.jwt() ->> 'email', '')) <> v_email then
    raise exception 'CONVITE_INVALIDO';
  end if;

  if coalesce(p_access_code, '') !~ '^[0-9]{8}$' then
    raise exception 'CONVITE_INVALIDO';
  end if;

  for v_invitation in
    select *
    from public.team_access_invitations i
    where lower(i.email) = v_email
      and i.status = 'pending'
      and i.expires_at > now()
    order by i.created_at desc
    for update
  loop
    if v_invitation.access_code_hash = extensions.crypt(p_access_code, v_invitation.access_code_hash) then
      v_found := true;
      exit;
    end if;
  end loop;

  if not v_found then
    raise exception 'CONVITE_INVALIDO';
  end if;

  update public.profiles p
  set auth_user_id = auth.uid(),
      name = v_invitation.name,
      phone = v_invitation.phone,
      role = v_invitation.role,
      status = 'active',
      last_seen_at = now()
  where p.organization_id = v_invitation.organization_id
    and lower(p.email) = v_email;

  if not found then
    raise exception 'CONVITE_INVALIDO';
  end if;

  update public.team_access_invitations
  set status = 'used', used_at = now()
  where organization_id = v_invitation.organization_id
    and email = v_invitation.email;

  return query
  select p.organization_id, p.name, p.phone, p.role, p.status
  from public.profiles p
  where p.organization_id = v_invitation.organization_id
    and lower(p.email) = v_email
  limit 1;
end;
$$;

revoke all on function public.activate_team_access_invitation(text, text) from public;
grant execute on function public.activate_team_access_invitation(text, text) to authenticated;
