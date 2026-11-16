create extension if not exists pgcrypto;

create table if not exists public.cash_register_access_codes (
  organization_id uuid not null,
  user_id uuid not null,
  pin_hash text not null,
  active boolean not null default true,
  assigned_by uuid not null,
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

alter table public.cash_register_access_codes enable row level security;
revoke all on public.cash_register_access_codes from anon, authenticated;

create or replace function public.can_manage_cash_register_access(p_organization_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.profiles p
    where p.organization_id = p_organization_id
      and p.auth_user_id = auth.uid()
      and coalesce(lower(p.status), 'active') = 'active'
      and lower(coalesce(p.role, 'member')) = 'owner'
  );
$$;
revoke all on function public.can_manage_cash_register_access(uuid) from public;

create or replace function public.set_cashier_access_code(
  p_organization_id uuid,
  p_email text,
  p_code text
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not public.can_manage_cash_register_access(p_organization_id) then raise exception 'Sem permissao para definir codigos de caixa.'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{4,8}$' then raise exception 'O codigo de caixa deve ter entre 4 e 8 algarismos.'; end if;

  select p.auth_user_id into v_user_id
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(trim(coalesce(p.email, ''))) = lower(trim(coalesce(p_email, '')))
    and coalesce(lower(p.status), 'active') = 'active'
  limit 1;
  if v_user_id is null then raise exception 'Caixa nao encontrado ou inactivo.'; end if;

  insert into public.cash_register_access_codes (organization_id, user_id, pin_hash, active, assigned_by, assigned_at, updated_at)
  values (p_organization_id, v_user_id, crypt(p_code, gen_salt('bf', 10)), true, auth.uid(), now(), now())
  on conflict (organization_id, user_id) do update
  set pin_hash = excluded.pin_hash,
      active = true,
      assigned_by = excluded.assigned_by,
      assigned_at = now(),
      updated_at = now();
end;
$$;
revoke all on function public.set_cashier_access_code(uuid, text, text) from public;
grant execute on function public.set_cashier_access_code(uuid, text, text) to authenticated;

create or replace function public.verify_cashier_access_code(
  p_organization_id uuid,
  p_code text
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and coalesce(p_code, '') ~ '^[0-9]{4,8}$' and exists (
    select 1
    from public.cash_register_access_codes c
    join public.profiles p
      on p.organization_id = c.organization_id
      and p.auth_user_id = c.user_id
    where c.organization_id = p_organization_id
      and c.user_id = auth.uid()
      and c.active = true
      and coalesce(lower(p.status), 'active') = 'active'
      and c.pin_hash = crypt(p_code, c.pin_hash)
  );
$$;
revoke all on function public.verify_cashier_access_code(uuid, text) from public;

drop function if exists public.open_cash_register(uuid, numeric, text);

create function public.open_cash_register(
  p_organization_id uuid,
  p_opening_amount numeric,
  p_actor_name text default null,
  p_access_code text default null
)
returns public.cash_register_sessions
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if p_organization_id is null or not public.is_org_member(p_organization_id) then raise exception 'Sem permissao para abrir caixa nesta organizacao.'; end if;
  if not public.verify_cashier_access_code(p_organization_id, p_access_code) then raise exception 'Codigo de caixa invalido ou nao configurado. Peca ao responsavel para definir o seu codigo pessoal.'; end if;
  if coalesce(p_opening_amount, -1) < 0 then raise exception 'O fundo inicial nao pode ser negativo.'; end if;
  if exists (select 1 from public.cash_register_sessions where organization_id = p_organization_id and opened_by = auth.uid() and status = 'open') then
    raise exception 'Ja existe um tour de caixa aberto para este utilizador.';
  end if;

  insert into public.cash_register_sessions (organization_id, opened_by, opened_by_name, opening_amount)
  values (p_organization_id, auth.uid(), public.cash_register_actor_name(p_actor_name), coalesce(p_opening_amount, 0))
  returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.open_cash_register(uuid, numeric, text, text) from public;
grant execute on function public.open_cash_register(uuid, numeric, text, text) to authenticated;
