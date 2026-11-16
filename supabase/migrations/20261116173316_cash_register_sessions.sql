create extension if not exists pgcrypto;

create table if not exists public.cash_register_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  opened_at timestamptz not null default now(),
  opened_by uuid not null,
  opened_by_name text not null default '',
  opening_amount numeric(14, 2) not null default 0 check (opening_amount >= 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid,
  closed_by_name text,
  expected_amount numeric(14, 2),
  counted_amount numeric(14, 2),
  difference_amount numeric(14, 2),
  closing_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'open' and closed_at is null and counted_amount is null and difference_amount is null)
    or status = 'closed'
  )
);

create unique index if not exists cash_register_one_open_session_per_user_idx
  on public.cash_register_sessions (organization_id, opened_by)
  where status = 'open';

create index if not exists cash_register_sessions_org_opened_idx
  on public.cash_register_sessions (organization_id, opened_at desc);

create table if not exists public.cash_register_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  session_id uuid not null references public.cash_register_sessions(id) on delete restrict,
  movement_kind text not null check (movement_kind in ('cash_in', 'cash_out')),
  amount numeric(14, 2) not null check (amount > 0),
  reason text not null check (char_length(btrim(reason)) between 2 and 240),
  occurred_at timestamptz not null default now(),
  created_by uuid not null,
  created_by_name text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists cash_register_movements_session_created_idx
  on public.cash_register_movements (session_id, created_at desc);

alter table public.sales
  add column if not exists cash_register_session_id uuid references public.cash_register_sessions(id) on delete restrict;

create index if not exists sales_cash_register_session_idx
  on public.sales (cash_register_session_id, sale_date desc)
  where cash_register_session_id is not null;

create or replace function public.validate_cash_register_sale_session()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
begin
  if new.cash_register_session_id is null then return new; end if;
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria para associar uma venda a caixa.'; end if;
  select * into v_session from public.cash_register_sessions where id = new.cash_register_session_id for share;
  if not found or v_session.organization_id <> new.organization_id then raise exception 'Tour de caixa invalido para esta venda.'; end if;
  if v_session.status <> 'open' then raise exception 'Nao e possivel registar uma venda num tour de caixa fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'A venda deve usar o tour de caixa aberto pelo proprio caixa.'; end if;
  return new;
end;
$$;
revoke all on function public.validate_cash_register_sale_session() from public;

drop trigger if exists sales_validate_cash_register_session on public.sales;
create trigger sales_validate_cash_register_session
before insert or update of cash_register_session_id on public.sales
for each row execute function public.validate_cash_register_sale_session();

alter table public.cash_register_sessions enable row level security;
alter table public.cash_register_movements enable row level security;

grant select on public.cash_register_sessions to authenticated;
grant select on public.cash_register_movements to authenticated;
revoke all on public.cash_register_sessions from anon;
revoke all on public.cash_register_movements from anon;

drop policy if exists cash_register_sessions_member_select on public.cash_register_sessions;
create policy cash_register_sessions_member_select
  on public.cash_register_sessions for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists cash_register_movements_member_select on public.cash_register_movements;
create policy cash_register_movements_member_select
  on public.cash_register_movements for select to authenticated
  using (public.is_org_member(organization_id));

create or replace function public.cash_register_actor_name(p_fallback text)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(trim((select p.name from public.profiles p where p.auth_user_id = auth.uid() limit 1)), ''),
    nullif(trim(p_fallback), ''),
    'Utilizador'
  );
$$;
revoke all on function public.cash_register_actor_name(text) from public;

create or replace function public.open_cash_register(
  p_organization_id uuid,
  p_opening_amount numeric,
  p_actor_name text default null
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
revoke all on function public.open_cash_register(uuid, numeric, text) from public;
grant execute on function public.open_cash_register(uuid, numeric, text) to authenticated;

create or replace function public.get_cash_register_summary(p_session_id uuid)
returns table (
  opening_amount numeric,
  cash_sales numeric,
  cash_in numeric,
  cash_out numeric,
  expected_amount numeric
)
language sql security definer
set search_path = public, pg_temp
as $$
  select
    s.opening_amount,
    coalesce(sales.cash_sales, 0),
    coalesce(movements.cash_in, 0),
    coalesce(movements.cash_out, 0),
    s.opening_amount + coalesce(sales.cash_sales, 0) + coalesce(movements.cash_in, 0) - coalesce(movements.cash_out, 0)
  from public.cash_register_sessions s
  left join lateral (
    select coalesce(sum(
      coalesce((
        select sum(nullif(line->>'montant', '')::numeric)
        from jsonb_array_elements(coalesce(sa.payment_lines, '[]'::jsonb)) line
        where lower(coalesce(line->>'method', '')) in ('cash', 'dinheiro')
      ), 0)
    ), 0) as cash_sales
    from public.sales sa
    where sa.cash_register_session_id = s.id
  ) sales on true
  left join lateral (
    select
      coalesce(sum(case when m.movement_kind = 'cash_in' then m.amount else 0 end), 0) as cash_in,
      coalesce(sum(case when m.movement_kind = 'cash_out' then m.amount else 0 end), 0) as cash_out
    from public.cash_register_movements m
    where m.session_id = s.id
  ) movements on true
  where s.id = p_session_id
    and auth.uid() is not null
    and public.is_org_member(s.organization_id);
$$;
revoke all on function public.get_cash_register_summary(uuid) from public;
grant execute on function public.get_cash_register_summary(uuid) to authenticated;

create or replace function public.add_cash_register_movement(
  p_session_id uuid,
  p_movement_kind text,
  p_amount numeric,
  p_reason text,
  p_actor_name text default null
)
returns public.cash_register_movements
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_movement public.cash_register_movements%rowtype;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  select * into v_session from public.cash_register_sessions where id = p_session_id;
  if not found or not public.is_org_member(v_session.organization_id) then raise exception 'Tour de caixa nao encontrado.'; end if;
  if v_session.status <> 'open' then raise exception 'Este tour de caixa ja esta fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'Apenas o caixa que abriu o tour pode registar movimentos.'; end if;
  if p_movement_kind not in ('cash_in', 'cash_out') then raise exception 'Tipo de movimento invalido.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Indique um montante valido.'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'Indique o motivo do movimento.'; end if;

  insert into public.cash_register_movements (organization_id, session_id, movement_kind, amount, reason, created_by, created_by_name)
  values (v_session.organization_id, v_session.id, p_movement_kind, p_amount, btrim(p_reason), auth.uid(), public.cash_register_actor_name(p_actor_name))
  returning * into v_movement;
  return v_movement;
end;
$$;
revoke all on function public.add_cash_register_movement(uuid, text, numeric, text, text) from public;
grant execute on function public.add_cash_register_movement(uuid, text, numeric, text, text) to authenticated;

create or replace function public.close_cash_register(
  p_session_id uuid,
  p_counted_amount numeric,
  p_closing_note text default null,
  p_actor_name text default null
)
returns public.cash_register_sessions
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_expected numeric;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  select * into v_session from public.cash_register_sessions where id = p_session_id for update;
  if not found or not public.is_org_member(v_session.organization_id) then raise exception 'Tour de caixa nao encontrado.'; end if;
  if v_session.status <> 'open' then raise exception 'Este tour de caixa ja esta fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'Apenas o caixa que abriu o tour pode fechar a caixa.'; end if;
  if coalesce(p_counted_amount, -1) < 0 then raise exception 'O montante contado nao pode ser negativo.'; end if;

  select expected_amount into v_expected from public.get_cash_register_summary(v_session.id);
  if abs(coalesce(p_counted_amount, 0) - coalesce(v_expected, 0)) > 0.009 and char_length(btrim(coalesce(p_closing_note, ''))) < 2 then
    raise exception 'Indique uma justificacao para o desvio de caixa.';
  end if;

  update public.cash_register_sessions
  set status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_by_name = public.cash_register_actor_name(p_actor_name),
      expected_amount = coalesce(v_expected, 0), counted_amount = p_counted_amount,
      difference_amount = p_counted_amount - coalesce(v_expected, 0), closing_note = nullif(btrim(coalesce(p_closing_note, '')), ''), updated_at = now()
  where id = v_session.id
  returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.close_cash_register(uuid, numeric, text, text) from public;
grant execute on function public.close_cash_register(uuid, numeric, text, text) to authenticated;

insert into public.role_permissions (organization_id, role_code, permission)
values
  (null, 'cashier', 'page:tresorerie'),
  (null, 'cashier', 'cash:view'),
  (null, 'cashier', 'cash:manage')
on conflict do nothing;
