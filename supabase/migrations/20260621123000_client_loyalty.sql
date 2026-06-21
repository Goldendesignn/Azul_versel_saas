create table if not exists public.loyalty_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  active boolean not null default false,
  kz_per_point numeric not null default 1000 check (kz_per_point > 0),
  redeem_points numeric not null default 10 check (redeem_points > 0),
  redeem_value numeric not null default 1000 check (redeem_value >= 0),
  created_by uuid,
  user_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table if not exists public.loyalty_clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_name text not null,
  client_phone text,
  token text not null default replace(gen_random_uuid()::text, '-', ''),
  points_balance numeric not null default 0,
  total_points_earned numeric not null default 0,
  total_points_used numeric not null default 0,
  total_spent numeric not null default 0,
  last_sale_at timestamptz,
  created_by uuid,
  user_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, client_name),
  unique (token)
);

create table if not exists public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  loyalty_client_id uuid references public.loyalty_clients(id) on delete cascade,
  sale_id uuid references public.sales(id) on delete set null,
  client_name text not null,
  type text not null check (type in ('earn', 'redeem', 'adjust')),
  points numeric not null default 0,
  amount numeric not null default 0,
  note text,
  created_by uuid,
  user_name text,
  created_at timestamptz not null default now()
);

create index if not exists loyalty_clients_org_points_idx
  on public.loyalty_clients (organization_id, points_balance desc);

create index if not exists loyalty_transactions_org_client_idx
  on public.loyalty_transactions (organization_id, loyalty_client_id, created_at desc);

alter table public.loyalty_settings enable row level security;
alter table public.loyalty_clients enable row level security;
alter table public.loyalty_transactions enable row level security;

drop policy if exists loyalty_settings_select_org on public.loyalty_settings;
create policy loyalty_settings_select_org
on public.loyalty_settings
for select
to authenticated
using (public.is_org_member(organization_id));

drop policy if exists loyalty_settings_insert_org on public.loyalty_settings;
create policy loyalty_settings_insert_org
on public.loyalty_settings
for insert
to authenticated
with check (public.is_org_member(organization_id));

drop policy if exists loyalty_settings_update_org on public.loyalty_settings;
create policy loyalty_settings_update_org
on public.loyalty_settings
for update
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists loyalty_clients_select_org on public.loyalty_clients;
create policy loyalty_clients_select_org
on public.loyalty_clients
for select
to authenticated
using (public.is_org_member(organization_id));

drop policy if exists loyalty_clients_insert_org on public.loyalty_clients;
create policy loyalty_clients_insert_org
on public.loyalty_clients
for insert
to authenticated
with check (public.is_org_member(organization_id));

drop policy if exists loyalty_clients_update_org on public.loyalty_clients;
create policy loyalty_clients_update_org
on public.loyalty_clients
for update
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists loyalty_transactions_select_org on public.loyalty_transactions;
create policy loyalty_transactions_select_org
on public.loyalty_transactions
for select
to authenticated
using (public.is_org_member(organization_id));

drop policy if exists loyalty_transactions_insert_org on public.loyalty_transactions;
create policy loyalty_transactions_insert_org
on public.loyalty_transactions
for insert
to authenticated
with check (public.is_org_member(organization_id));

grant select, insert, update on public.loyalty_settings to authenticated;
grant select, insert, update on public.loyalty_clients to authenticated;
grant select, insert on public.loyalty_transactions to authenticated;

create or replace function public.get_public_loyalty_card(p_token text)
returns table (
  organization_name text,
  client_name text,
  client_phone text,
  points_balance numeric,
  total_points_earned numeric,
  total_points_used numeric,
  total_spent numeric,
  last_sale_at timestamptz,
  kz_per_point numeric,
  redeem_points numeric,
  redeem_value numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(o.name, 'Azul')::text as organization_name,
    lc.client_name,
    lc.client_phone,
    lc.points_balance,
    lc.total_points_earned,
    lc.total_points_used,
    lc.total_spent,
    lc.last_sale_at,
    coalesce(ls.kz_per_point, 1000) as kz_per_point,
    coalesce(ls.redeem_points, 10) as redeem_points,
    coalesce(ls.redeem_value, 1000) as redeem_value
  from public.loyalty_clients lc
  join public.organizations o on o.id = lc.organization_id
  left join public.loyalty_settings ls on ls.organization_id = lc.organization_id
  where lc.token = p_token
  limit 1;
$$;

revoke all on function public.get_public_loyalty_card(text) from public;
grant execute on function public.get_public_loyalty_card(text) to anon, authenticated;
