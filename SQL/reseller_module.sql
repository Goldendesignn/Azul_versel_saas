create table if not exists public.reseller_consignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  consignment_no text not null,
  reseller_name text not null,
  consignment_date date not null default current_date,
  status text not null default 'open',
  total numeric not null default 0,
  paid_amount numeric not null default 0,
  payment_summary text,
  receipt_no text,
  closed_at timestamp with time zone,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.reseller_consignment_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  consignment_id uuid not null references public.reseller_consignments(id) on delete cascade,
  product_id uuid,
  product_name text not null,
  quantity integer not null default 0,
  unit_price numeric not null default 0,
  total numeric not null default 0,
  variation text,
  variations jsonb default '[]'::jsonb,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

alter table public.reseller_consignments
  add column if not exists organization_id uuid,
  add column if not exists consignment_no text,
  add column if not exists reseller_name text,
  add column if not exists consignment_date date default current_date,
  add column if not exists status text default 'open',
  add column if not exists total numeric default 0,
  add column if not exists paid_amount numeric default 0,
  add column if not exists payment_summary text,
  add column if not exists receipt_no text,
  add column if not exists closed_at timestamp with time zone,
  add column if not exists created_by uuid,
  add column if not exists user_name text,
  add column if not exists created_at timestamp with time zone default now();

alter table public.reseller_consignment_items
  add column if not exists organization_id uuid,
  add column if not exists consignment_id uuid,
  add column if not exists product_id uuid,
  add column if not exists product_name text,
  add column if not exists quantity integer default 0,
  add column if not exists unit_price numeric default 0,
  add column if not exists total numeric default 0,
  add column if not exists variation text,
  add column if not exists variations jsonb default '[]'::jsonb,
  add column if not exists created_by uuid,
  add column if not exists user_name text,
  add column if not exists created_at timestamp with time zone default now();

create index if not exists reseller_consignments_org_status_idx
  on public.reseller_consignments (organization_id, status, created_at desc);

create index if not exists reseller_consignments_org_reseller_idx
  on public.reseller_consignments (organization_id, lower(reseller_name));

create index if not exists reseller_items_consignment_idx
  on public.reseller_consignment_items (consignment_id);

alter table public.reseller_consignments enable row level security;
alter table public.reseller_consignment_items enable row level security;

drop policy if exists reseller_consignments_all_app on public.reseller_consignments;
create policy reseller_consignments_all_app
on public.reseller_consignments
for all
to public
using (organization_id is not null)
with check (organization_id is not null);

drop policy if exists reseller_items_all_app on public.reseller_consignment_items;
create policy reseller_items_all_app
on public.reseller_consignment_items
for all
to public
using (organization_id is not null)
with check (organization_id is not null);
