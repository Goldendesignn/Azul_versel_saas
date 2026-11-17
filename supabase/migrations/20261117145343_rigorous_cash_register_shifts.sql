-- A closed shift is immutable. Any discrepancy must be reviewed by an owner
-- or manager before the cashier can open another shift.
alter table public.cash_register_sessions
  add column if not exists review_status text not null default 'not_required',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_by_name text,
  add column if not exists review_note text;

alter table public.cash_register_sessions
  drop constraint if exists cash_register_sessions_review_status_check;
alter table public.cash_register_sessions
  add constraint cash_register_sessions_review_status_check
  check (review_status in ('not_required', 'pending', 'reviewed'));

update public.cash_register_sessions
set review_status = case
  when status = 'closed' and abs(coalesce(difference_amount, 0)) > 0.009 then 'pending'
  else 'not_required'
end
where review_status = 'not_required';

create table if not exists public.cash_register_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  session_id uuid not null references public.cash_register_sessions(id) on delete restrict,
  event_type text not null check (event_type in ('opened', 'cash_in', 'cash_out', 'closed', 'reviewed')),
  actor_id uuid not null,
  actor_name text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists cash_register_events_session_created_idx
  on public.cash_register_events (session_id, created_at asc);

alter table public.cash_register_events enable row level security;
revoke all on public.cash_register_events from anon, authenticated;
grant select on public.cash_register_events to authenticated;

drop policy if exists cash_register_events_member_select on public.cash_register_events;
create policy cash_register_events_member_select
  on public.cash_register_events for select to authenticated
  using (
    public.can_supervise_cash_register(organization_id)
    or exists (
      select 1
      from public.cash_register_sessions s
      where s.id = cash_register_events.session_id
        and s.opened_by = (select auth.uid())
    )
  );

create or replace function public.can_operate_cash_register(
  p_organization_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null and exists (
    select 1
    from public.profiles p
    where p.organization_id = p_organization_id
      and p.auth_user_id = p_user_id
      and coalesce(lower(p.status), 'active') = 'active'
      and (
        lower(coalesce(p.role, 'member')) in ('owner', 'manager')
        or exists (
          select 1
          from public.role_permissions rp
          where lower(rp.role_code) = lower(coalesce(p.role, 'member'))
            and rp.permission = 'cash:manage'
            and (rp.organization_id is null or rp.organization_id = p_organization_id)
        )
      )
  );
$$;
revoke all on function public.can_operate_cash_register(uuid, uuid) from public;

create or replace function public.open_cash_register(
  p_organization_id uuid,
  p_opening_amount numeric,
  p_actor_name text default null,
  p_access_code text default null
)
returns public.cash_register_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if p_organization_id is null or not public.is_org_member(p_organization_id) then
    raise exception 'Sem permissao para abrir caixa nesta organizacao.';
  end if;
  if not public.can_operate_cash_register(p_organization_id, auth.uid()) then
    raise exception 'O seu role nao possui permissao para operar a caixa.';
  end if;
  if not public.verify_cashier_access_code(p_organization_id, p_access_code) then
    raise exception 'Codigo de caixa invalido ou nao configurado. Peca ao responsavel para definir o seu codigo pessoal.';
  end if;
  if coalesce(p_opening_amount, -1) < 0 then raise exception 'O fundo inicial nao pode ser negativo.'; end if;
  if exists (
    select 1 from public.cash_register_sessions s
    where s.organization_id = p_organization_id
      and s.opened_by = auth.uid()
      and s.review_status = 'pending'
  ) then
    raise exception 'O seu ultimo tour tem um desvio pendente de verificacao pelo responsavel.';
  end if;
  if exists (
    select 1 from public.cash_register_sessions s
    where s.organization_id = p_organization_id
      and s.opened_by = auth.uid()
      and s.status = 'open'
  ) then
    raise exception 'Ja existe um tour de caixa aberto para este utilizador.';
  end if;

  v_actor_name := public.cash_register_actor_name(p_actor_name);
  insert into public.cash_register_sessions (organization_id, opened_by, opened_by_name, opening_amount)
  values (p_organization_id, auth.uid(), v_actor_name, coalesce(p_opening_amount, 0))
  returning * into v_session;

  insert into public.cash_register_events (organization_id, session_id, event_type, actor_id, actor_name, details)
  values (v_session.organization_id, v_session.id, 'opened', auth.uid(), v_actor_name,
    jsonb_build_object('opening_amount', v_session.opening_amount));
  return v_session;
end;
$$;
revoke all on function public.open_cash_register(uuid, numeric, text, text) from public;
grant execute on function public.open_cash_register(uuid, numeric, text, text) to authenticated;

create or replace function public.add_cash_register_movement(
  p_session_id uuid,
  p_movement_kind text,
  p_amount numeric,
  p_reason text,
  p_actor_name text default null
)
returns public.cash_register_movements
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_movement public.cash_register_movements%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  select * into v_session from public.cash_register_sessions where id = p_session_id for update;
  if not found or not public.is_org_member(v_session.organization_id) then raise exception 'Tour de caixa nao encontrado.'; end if;
  if v_session.status <> 'open' then raise exception 'Este tour de caixa ja esta fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'Apenas o caixa que abriu o tour pode registar movimentos.'; end if;
  if p_movement_kind not in ('cash_in', 'cash_out') then raise exception 'Tipo de movimento invalido.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Indique um montante valido.'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'Indique o motivo do movimento.'; end if;

  v_actor_name := public.cash_register_actor_name(p_actor_name);
  insert into public.cash_register_movements (organization_id, session_id, movement_kind, amount, reason, created_by, created_by_name)
  values (v_session.organization_id, v_session.id, p_movement_kind, p_amount, btrim(p_reason), auth.uid(), v_actor_name)
  returning * into v_movement;

  insert into public.cash_register_events (organization_id, session_id, event_type, actor_id, actor_name, details)
  values (v_session.organization_id, v_session.id, p_movement_kind, auth.uid(), v_actor_name,
    jsonb_build_object('movement_id', v_movement.id, 'amount', v_movement.amount, 'reason', v_movement.reason));
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
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_expected numeric;
  v_difference numeric;
  v_review_status text;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  select * into v_session from public.cash_register_sessions where id = p_session_id for update;
  if not found or not public.is_org_member(v_session.organization_id) then raise exception 'Tour de caixa nao encontrado.'; end if;
  if v_session.status <> 'open' then raise exception 'Este tour de caixa ja esta fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'Apenas o caixa que abriu o tour pode fechar a caixa.'; end if;
  if coalesce(p_counted_amount, -1) < 0 then raise exception 'O montante contado nao pode ser negativo.'; end if;

  select expected_amount into v_expected from public.get_cash_register_summary(v_session.id);
  v_difference := coalesce(p_counted_amount, 0) - coalesce(v_expected, 0);
  if abs(v_difference) > 0.009 and char_length(btrim(coalesce(p_closing_note, ''))) < 2 then
    raise exception 'Indique uma justificacao para o desvio de caixa.';
  end if;
  v_review_status := case when abs(v_difference) > 0.009 then 'pending' else 'not_required' end;
  v_actor_name := public.cash_register_actor_name(p_actor_name);

  update public.cash_register_sessions
  set status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_by_name = v_actor_name,
      expected_amount = coalesce(v_expected, 0), counted_amount = p_counted_amount,
      difference_amount = v_difference, closing_note = nullif(btrim(coalesce(p_closing_note, '')), ''),
      review_status = v_review_status, updated_at = now()
  where id = v_session.id
  returning * into v_session;

  insert into public.cash_register_events (organization_id, session_id, event_type, actor_id, actor_name, details)
  values (v_session.organization_id, v_session.id, 'closed', auth.uid(), v_actor_name,
    jsonb_build_object('expected_amount', v_session.expected_amount, 'counted_amount', v_session.counted_amount,
      'difference_amount', v_session.difference_amount, 'review_status', v_session.review_status,
      'closing_note', coalesce(v_session.closing_note, '')));
  return v_session;
end;
$$;
revoke all on function public.close_cash_register(uuid, numeric, text, text) from public;
grant execute on function public.close_cash_register(uuid, numeric, text, text) to authenticated;

create or replace function public.review_cash_register_shift(
  p_session_id uuid,
  p_review_note text,
  p_actor_name text default null
)
returns public.cash_register_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  select * into v_session from public.cash_register_sessions where id = p_session_id for update;
  if not found then raise exception 'Tour de caixa nao encontrado.'; end if;
  if not public.can_supervise_cash_register(v_session.organization_id) then
    raise exception 'Apenas o proprietario ou gerente pode rever um desvio de caixa.';
  end if;
  if v_session.status <> 'closed' or v_session.review_status <> 'pending' then
    raise exception 'Este tour nao possui um desvio pendente de revisao.';
  end if;
  if char_length(btrim(coalesce(p_review_note, ''))) < 5 then
    raise exception 'Indique uma nota de revisao com pelo menos 5 caracteres.';
  end if;

  v_actor_name := public.cash_register_actor_name(p_actor_name);
  update public.cash_register_sessions
  set review_status = 'reviewed', reviewed_at = now(), reviewed_by = auth.uid(),
      reviewed_by_name = v_actor_name, review_note = btrim(p_review_note), updated_at = now()
  where id = v_session.id
  returning * into v_session;

  insert into public.cash_register_events (organization_id, session_id, event_type, actor_id, actor_name, details)
  values (v_session.organization_id, v_session.id, 'reviewed', auth.uid(), v_actor_name,
    jsonb_build_object('review_note', v_session.review_note, 'difference_amount', v_session.difference_amount));
  return v_session;
end;
$$;
revoke all on function public.review_cash_register_shift(uuid, text, text) from public;
grant execute on function public.review_cash_register_shift(uuid, text, text) to authenticated;
