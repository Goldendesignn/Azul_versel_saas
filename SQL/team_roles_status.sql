alter table public.profiles
  add column if not exists role text;

alter table public.profiles
  add column if not exists status text;

alter table public.profiles
  add column if not exists last_seen_at timestamp with time zone;

alter table public.profiles
  add column if not exists auth_user_id uuid;

update public.profiles
set role = 'member'
where role is null or trim(role) = '';

update public.profiles
set status = 'active'
where status is null or trim(status) = '';

alter table public.profiles
  alter column role set default 'member';

alter table public.profiles
  alter column status set default 'active';

create index if not exists profiles_organization_email_idx
  on public.profiles (organization_id, lower(email));

create index if not exists profiles_organization_status_idx
  on public.profiles (organization_id, status);

drop function if exists public.get_organization_team(uuid);

create or replace function public.get_organization_team(p_organization_id uuid)
returns table (
  name text,
  email text,
  phone text,
  role text,
  status text,
  last_seen_at timestamp with time zone
)
language sql
security definer
set search_path = public
as $$
  select
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'active') as status,
    p.last_seen_at
  from public.profiles p
  where p.organization_id = p_organization_id
    and exists (
      select 1
      from public.profiles me
      where me.organization_id = p_organization_id
        and coalesce(nullif(me.status, ''), 'active') = 'active'
        and (
          me.auth_user_id = auth.uid()
          or lower(me.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    )
  order by
    case coalesce(nullif(p.status, ''), 'active')
      when 'active' then 1
      else 2
    end,
    case coalesce(nullif(p.role, ''), 'member')
      when 'owner' then 1
      when 'manager' then 2
      when 'cashier' then 3
      when 'stock' then 4
      when 'accountant' then 5
      else 9
    end,
    lower(coalesce(p.name, p.email, ''));
$$;

grant execute on function public.get_organization_team(uuid) to authenticated;

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
    and (
      auth_user_id = auth.uid()
      or lower(email) = v_email
    )
    and coalesce(nullif(status, ''), 'pending') = 'active';
end;
$$;

grant execute on function public.touch_team_user(uuid, text, text, text, text) to authenticated;
