create extension if not exists pgcrypto;

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  transfer_date date not null default current_date,
  product_id uuid,
  product_name text not null,
  quantity numeric not null default 0,
  from_location text not null default 'Armazem',
  to_location text not null default 'Loja',
  transfer_type text not null default 'single_to_shop',
  note text,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

alter table public.stock_transfers
  add column if not exists organization_id uuid,
  add column if not exists transfer_date date default current_date,
  add column if not exists product_id uuid,
  add column if not exists product_name text,
  add column if not exists quantity numeric default 0,
  add column if not exists from_location text default 'Armazem',
  add column if not exists to_location text default 'Loja',
  add column if not exists transfer_type text default 'single_to_shop',
  add column if not exists note text,
  add column if not exists created_by uuid,
  add column if not exists user_name text,
  add column if not exists created_at timestamp with time zone default now();

create index if not exists stock_transfers_org_date_idx
  on public.stock_transfers (organization_id, transfer_date desc, created_at desc);

create index if not exists stock_transfers_org_product_idx
  on public.stock_transfers (organization_id, lower(product_name));

alter table public.stock_transfers enable row level security;

drop policy if exists stock_transfers_all_app on public.stock_transfers;

create policy stock_transfers_all_app
on public.stock_transfers
for all
to public
using (organization_id is not null)
with check (organization_id is not null);

grant select, insert, update, delete on public.stock_transfers to anon, authenticated;
