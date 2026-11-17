create or replace function public.get_cashier_supervision(p_organization_id uuid)
returns table (
  name text,
  email text,
  phone text,
  role text,
  status text,
  last_seen_at timestamptz,
  session_id uuid,
  cash_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  expected_amount numeric,
  counted_amount numeric,
  difference_amount numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and p.auth_user_id = auth.uid()
    and coalesce(nullif(p.status, ''), 'active') = 'active'
  limit 1;

  if v_actor_role not in ('owner', 'manager') then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  return query
  select
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'active') as status,
    p.last_seen_at,
    s.id as session_id,
    s.status as cash_status,
    s.opened_at,
    s.closed_at,
    s.expected_amount,
    s.counted_amount,
    s.difference_amount
  from public.profiles p
  left join lateral (
    select cs.*
    from public.cash_register_sessions cs
    where cs.organization_id = p_organization_id
      and p.auth_user_id is not null
      and cs.opened_by = p.auth_user_id
    order by case when cs.status = 'open' then 0 else 1 end, cs.opened_at desc
    limit 1
  ) s on true
  where p.organization_id = p_organization_id
    and (
      lower(coalesce(p.role, 'member')) = 'cashier'
      or exists (
        select 1
        from public.role_permissions rp
        where lower(rp.role_code) = lower(coalesce(p.role, 'member'))
          and rp.permission = 'cash:manage'
          and (rp.organization_id is null or rp.organization_id = p_organization_id)
      )
    )
  order by
    case s.status when 'open' then 0 else 1 end,
    lower(coalesce(p.name, p.email, ''));
end;
$$;

revoke all on function public.get_cashier_supervision(uuid) from public;
grant execute on function public.get_cashier_supervision(uuid) to authenticated;

create or replace function public.get_cashier_shift_history(
  p_organization_id uuid,
  p_email text
)
returns table (
  session_id uuid,
  opened_at timestamptz,
  closed_at timestamptz,
  status text,
  opening_amount numeric,
  expected_amount numeric,
  counted_amount numeric,
  difference_amount numeric,
  closing_note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and p.auth_user_id = auth.uid()
    and coalesce(nullif(p.status, ''), 'active') = 'active'
  limit 1;

  if v_actor_role not in ('owner', 'manager') then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  select p.auth_user_id into v_user_id
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = lower(trim(coalesce(p_email, '')))
  limit 1;

  if v_user_id is null then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  return query
  select
    cs.id,
    cs.opened_at,
    cs.closed_at,
    cs.status,
    cs.opening_amount,
    cs.expected_amount,
    cs.counted_amount,
    cs.difference_amount,
    cs.closing_note
  from public.cash_register_sessions cs
  where cs.organization_id = p_organization_id
    and cs.opened_by = v_user_id
  order by cs.opened_at desc
  limit 50;
end;
$$;

revoke all on function public.get_cashier_shift_history(uuid, text) from public;
grant execute on function public.get_cashier_shift_history(uuid, text) to authenticated;
