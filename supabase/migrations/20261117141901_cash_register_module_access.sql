-- Caixa is a separate operational module. Cashiers may see only their own
-- shifts, while owners and managers can supervise the whole organisation.
create or replace function public.can_supervise_cash_register(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.profiles p
    where p.organization_id = p_organization_id
      and p.auth_user_id = auth.uid()
      and coalesce(lower(p.status), 'active') = 'active'
      and lower(coalesce(p.role, 'member')) in ('owner', 'manager')
  );
$$;
revoke all on function public.can_supervise_cash_register(uuid) from public;
grant execute on function public.can_supervise_cash_register(uuid) to authenticated;

drop policy if exists cash_register_sessions_member_select on public.cash_register_sessions;
create policy cash_register_sessions_member_select
  on public.cash_register_sessions for select to authenticated
  using (
    (select auth.uid()) = opened_by
    or public.can_supervise_cash_register(organization_id)
  );

drop policy if exists cash_register_movements_member_select on public.cash_register_movements;
create policy cash_register_movements_member_select
  on public.cash_register_movements for select to authenticated
  using (
    public.can_supervise_cash_register(organization_id)
    or exists (
      select 1
      from public.cash_register_sessions s
      where s.id = cash_register_movements.session_id
        and s.opened_by = (select auth.uid())
    )
  );

create or replace function public.get_cash_register_summary(p_session_id uuid)
returns table (
  opening_amount numeric,
  cash_sales numeric,
  cash_in numeric,
  cash_out numeric,
  expected_amount numeric
)
language sql
security definer
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
    and (
      s.opened_by = auth.uid()
      or public.can_supervise_cash_register(s.organization_id)
    );
$$;
revoke all on function public.get_cash_register_summary(uuid) from public;
grant execute on function public.get_cash_register_summary(uuid) to authenticated;

delete from public.role_permissions
where organization_id is null
  and role_code = 'cashier'
  and permission = 'page:tresorerie';

insert into public.role_permissions (organization_id, role_code, permission)
values (null, 'cashier', 'page:caixa')
on conflict do nothing;
