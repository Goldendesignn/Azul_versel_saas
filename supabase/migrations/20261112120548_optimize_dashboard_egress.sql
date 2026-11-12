-- Reduz leituras repetidas e o volume devolvido ao navegador.
-- Os indices correspondem aos filtros usados pelos ecrans financeiros do Azul.

create index if not exists sales_org_date_idx
  on public.sales (organization_id, sale_date desc);

create index if not exists purchases_org_created_idx
  on public.purchases (organization_id, created_at desc);

create index if not exists expenses_org_date_idx
  on public.expenses (organization_id, expense_date desc);

create index if not exists client_payments_org_date_idx
  on public.client_payments (organization_id, payment_date desc);

create index if not exists supplier_payments_org_date_idx
  on public.supplier_payments (organization_id, payment_date desc);

create index if not exists treasury_entries_org_date_idx
  on public.treasury_entries (organization_id, entry_date desc);

create index if not exists notifications_org_created_idx
  on public.notifications (organization_id, created_at desc);

create index if not exists online_orders_pending_reminder_idx
  on public.online_orders (organization_id, scheduled_for)
  where scheduled_for is not null and reminder_sent_at is null;

create index if not exists deliveries_pending_reminder_idx
  on public.deliveries (organization_id, scheduled_for)
  where scheduled_for is not null and reminder_sent_at is null;

-- Une seule petite reponse remplace le telechargement de toutes les lignes
-- ventes, achats et depenses pour les cartes fiscales du navigateur.
create or replace function public.get_azul_period_summary(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns table (
  sales_total numeric,
  purchases_total numeric,
  expenses_total numeric,
  sales_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce((
      select sum(s.total)
      from public.sales s
      where s.organization_id = p_organization_id
        and s.sale_date >= p_from
        and s.sale_date <= p_to
    ), 0) as sales_total,
    coalesce((
      select sum(p.total)
      from public.purchases p
      where p.organization_id = p_organization_id
        and p.created_at >= p_from
        and p.created_at < (p_to + 1)::timestamp
    ), 0) as purchases_total,
    coalesce((
      select sum(e.amount)
      from public.expenses e
      where e.organization_id = p_organization_id
        and e.expense_date >= p_from
        and e.expense_date <= p_to
    ), 0) as expenses_total,
    coalesce((
      select count(*)
      from public.sales s
      where s.organization_id = p_organization_id
        and s.sale_date >= p_from
        and s.sale_date <= p_to
    ), 0) as sales_count;
$$;

revoke all on function public.get_azul_period_summary(uuid, date, date) from public;
grant execute on function public.get_azul_period_summary(uuid, date, date) to authenticated;
