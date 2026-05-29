-- Azul Gestao Production V1 - base schema
-- Execute este ficheiro primeiro numa base Supabase nova.
-- Depois execute os ficheiros dos modulos indicados em SUPABASE_PRODUCTION_SETUP.md.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Licenca em espera',
  status text not null default 'pending',
  plan text not null default 'starter',
  owner_name text,
  owner_phone text,
  owner_email text,
  expires_at timestamp with time zone,
  notes text,
  device_limit integer not null default 1,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  license_key text not null unique,
  status text not null default 'unused',
  plan text not null default 'starter',
  expires_at timestamp with time zone,
  activation_count integer not null default 0,
  activation_limit integer not null default 1,
  used_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  name text,
  phone text,
  email text not null,
  role text not null default 'member',
  status text not null default 'pending',
  last_seen_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  unique (organization_id, email)
);

create table if not exists public.organization_devices (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id text not null,
  device_name text,
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  last_seen_at timestamp with time zone,
  primary key (organization_id, device_id)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  category text,
  supplier text,
  purchase_price numeric not null default 0,
  sale_price numeric not null default 0,
  stock_warehouse integer not null default 0,
  stock_shop integer not null default 0,
  min_stock integer not null default 0,
  code text,
  variation text,
  variations jsonb not null default '[]'::jsonb,
  photo text,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  phone text,
  country text,
  note text,
  created_at timestamp with time zone not null default now(),
  unique (organization_id, name)
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  receipt_no text,
  sale_date date not null default current_date,
  client_name text not null default 'Anonimo',
  sale_type text not null default 'interno',
  payment_method text,
  payment_summary text,
  payment_lines jsonb not null default '[]'::jsonb,
  total numeric not null default 0,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null default 0,
  unit_price numeric not null default 0,
  total numeric not null default 0,
  purchase_price numeric not null default 0,
  profit numeric not null default 0,
  variation text,
  variations jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.client_debts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  client_name text not null,
  sale_id uuid references public.sales(id) on delete set null,
  total_amount numeric not null default 0,
  paid_amount numeric not null default 0,
  remaining_amount numeric not null default 0,
  status text not null default 'open',
  debt_date date not null default current_date,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.client_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  client_name text not null,
  amount numeric not null default 0,
  note text,
  payment_date date not null default current_date,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  supplier text not null,
  total numeric not null default 0,
  paid_amount numeric not null default 0,
  remaining_amount numeric not null default 0,
  is_credit boolean not null default false,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references public.purchases(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  category text,
  code text,
  photo text,
  variation text,
  variations jsonb not null default '[]'::jsonb,
  purchase_price numeric not null default 0,
  sale_price numeric not null default 0,
  quantity integer not null default 0,
  supplier text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  supplier text not null,
  amount numeric not null default 0,
  note text,
  payment_date date not null default current_date,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  expense_date date not null default current_date,
  category text not null default 'Geral',
  description text,
  amount numeric not null default 0,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.treasury_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  entry_date date not null default current_date,
  movement text not null default 'entrada',
  type text,
  description text,
  amount numeric not null default 0,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.accounting_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  entry_date date not null default current_date,
  source_type text not null,
  source_id uuid,
  description text,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.accounting_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  entry_id uuid references public.accounting_entries(id) on delete cascade,
  account_code text not null,
  account_name text,
  debit numeric not null default 0,
  credit numeric not null default 0,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_licenses_key on public.licenses (upper(license_key));
create index if not exists idx_profiles_org_email on public.profiles (organization_id, lower(email));
create index if not exists idx_products_org_name on public.products (organization_id, lower(name));
create index if not exists idx_sales_org_date on public.sales (organization_id, sale_date);
create index if not exists idx_purchases_org_created on public.purchases (organization_id, created_at);
create index if not exists idx_expenses_org_date on public.expenses (organization_id, expense_date);
create index if not exists idx_accounting_entries_org_date on public.accounting_entries (organization_id, entry_date);

create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
set search_path to public, auth
as $$
declare
  v_uid uuid;
  v_email text;
begin
  v_uid := auth.uid();

  if v_uid is null then
    return false;
  end if;

  select email into v_email
  from auth.users
  where id = v_uid
  limit 1;

  return exists (
    select 1
    from public.admin_users au
    where au.active = true
      and (
        au.user_id = v_uid
        or lower(coalesce(au.email, '')) = lower(coalesce(v_email, ''))
        or lower(coalesce(au.email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
  );
end;
$$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
security definer
set search_path to public, auth
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.profiles p
      where p.organization_id = p_organization_id
        and coalesce(p.status, 'active') = 'active'
        and (
          p.auth_user_id = auth.uid()
          or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    );
$$;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;

alter table public.organizations enable row level security;
alter table public.licenses enable row level security;
alter table public.admin_users enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_devices enable row level security;
alter table public.products enable row level security;
alter table public.suppliers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.client_debts enable row level security;
alter table public.client_payments enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.expenses enable row level security;
alter table public.treasury_entries enable row level security;
alter table public.accounting_entries enable row level security;
alter table public.accounting_lines enable row level security;

drop policy if exists organizations_app_access on public.organizations;
create policy organizations_app_access on public.organizations
for all to anon, authenticated
using (public.is_org_member(id))
with check (public.is_admin());

drop policy if exists licenses_app_access on public.licenses;
create policy licenses_app_access on public.licenses
for all to anon, authenticated
using (public.is_admin() or public.is_org_member(organization_id))
with check (public.is_admin());

drop policy if exists admin_users_admin_access on public.admin_users;
create policy admin_users_admin_access on public.admin_users
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists profiles_member_access on public.profiles;
create policy profiles_member_access on public.profiles
for all to anon, authenticated
using (
  public.is_admin()
  or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or public.is_org_member(organization_id)
)
with check (
  public.is_admin()
  or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or public.is_org_member(organization_id)
);

drop policy if exists organization_devices_member_access on public.organization_devices;
create policy organization_devices_member_access on public.organization_devices
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists products_member_access on public.products;
create policy products_member_access on public.products
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists suppliers_member_access on public.suppliers;
create policy suppliers_member_access on public.suppliers
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists sales_member_access on public.sales;
create policy sales_member_access on public.sales
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists sale_items_member_access on public.sale_items;
create policy sale_items_member_access on public.sale_items
for all to anon, authenticated
using (
  exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id
      and public.is_org_member(s.organization_id)
  )
)
with check (
  exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id
      and public.is_org_member(s.organization_id)
  )
);

drop policy if exists client_debts_member_access on public.client_debts;
create policy client_debts_member_access on public.client_debts
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists client_payments_member_access on public.client_payments;
create policy client_payments_member_access on public.client_payments
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists purchases_member_access on public.purchases;
create policy purchases_member_access on public.purchases
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists purchase_items_member_access on public.purchase_items;
create policy purchase_items_member_access on public.purchase_items
for all to anon, authenticated
using (
  exists (
    select 1 from public.purchases p
    where p.id = purchase_items.purchase_id
      and public.is_org_member(p.organization_id)
  )
)
with check (
  exists (
    select 1 from public.purchases p
    where p.id = purchase_items.purchase_id
      and public.is_org_member(p.organization_id)
  )
);

drop policy if exists supplier_payments_member_access on public.supplier_payments;
create policy supplier_payments_member_access on public.supplier_payments
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists expenses_member_access on public.expenses;
create policy expenses_member_access on public.expenses
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists treasury_entries_member_access on public.treasury_entries;
create policy treasury_entries_member_access on public.treasury_entries
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists accounting_entries_member_access on public.accounting_entries;
create policy accounting_entries_member_access on public.accounting_entries
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists accounting_lines_member_access on public.accounting_lines;
create policy accounting_lines_member_access on public.accounting_lines
for all to anon, authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));
