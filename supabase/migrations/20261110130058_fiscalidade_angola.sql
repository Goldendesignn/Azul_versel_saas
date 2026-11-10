-- Azul Gestao - fiscalidade angolaise par organisation.
-- Le module prepare les chiffres et les echeances. Il ne transmet jamais une declaration a l'AGT.

create table if not exists public.fiscal_profiles (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  legal_name text,
  nif text,
  fiscal_address text,
  tax_regime text not null default 'geral',
  vat_rate numeric(5,2) not null default 14.00 check (vat_rate >= 0 and vat_rate <= 100),
  prices_include_vat boolean not null default true,
  iva_due_day smallint check (iva_due_day between 1 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fiscal_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_month date not null,
  status text not null default 'draft' check (status in ('draft', 'prepared', 'declared', 'paid')),
  taxable_sales numeric(14,2) not null default 0,
  deductible_purchases numeric(14,2) not null default 0,
  vat_collected numeric(14,2) not null default 0,
  vat_deductible numeric(14,2) not null default 0,
  vat_balance numeric(14,2) not null default 0,
  note text,
  prepared_by uuid,
  prepared_at timestamptz,
  declared_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, period_month)
);

create index if not exists fiscal_periods_org_month_idx
  on public.fiscal_periods (organization_id, period_month desc);

alter table public.fiscal_profiles enable row level security;
alter table public.fiscal_periods enable row level security;

grant select, insert, update, delete on public.fiscal_profiles to authenticated;
grant select, insert, update, delete on public.fiscal_periods to authenticated;
revoke all on public.fiscal_profiles from anon;
revoke all on public.fiscal_periods from anon;

drop policy if exists fiscal_profiles_member_all on public.fiscal_profiles;
create policy fiscal_profiles_member_all on public.fiscal_profiles
  for all to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists fiscal_periods_member_all on public.fiscal_periods;
create policy fiscal_periods_member_all on public.fiscal_periods
  for all to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

insert into public.role_permissions (organization_id, role_code, permission)
values
  (null, 'accountant', 'page:fiscalidade'),
  (null, 'accountant', 'fiscal:view'),
  (null, 'accountant', 'fiscal:manage'),
  (null, 'readonly', 'page:fiscalidade'),
  (null, 'readonly', 'fiscal:view')
on conflict do nothing;
