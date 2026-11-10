create table if not exists public.import_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_no text not null,
  supplier text not null,
  origin_country text default '',
  agent_name text default '',
  tracking_no text default '',
  carrier text default '',
  status text not null default 'ordered',
  order_date date not null default current_date,
  expected_arrival date,
  arrived_at date,
  validated_at timestamp with time zone,
  supplier_total numeric not null default 0,
  shipping_cost numeric not null default 0,
  customs_cost numeric not null default 0,
  other_cost numeric not null default 0,
  notes text default '',
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint import_orders_status_check check (
    status in (
      'ordered',
      'paid',
      'production',
      'shipped',
      'transit',
      'arrived_angola',
      'checking',
      'completed',
      'cancelled'
    )
  ),
  constraint import_orders_org_order_no_unique unique (organization_id, order_no)
);

create table if not exists public.import_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.import_orders(id) on delete cascade,
  product_name text not null,
  code text default '',
  category text default '',
  variation text default '',
  variations jsonb not null default '[]'::jsonb,
  photo text default '',
  ordered_quantity numeric not null default 0,
  received_quantity numeric not null default 0,
  damaged_quantity numeric not null default 0,
  missing_quantity numeric not null default 0,
  purchase_price numeric not null default 0,
  sale_price numeric not null default 0,
  notes text default '',
  stock_product_id uuid references public.products(id) on delete set null,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists import_orders_org_status_idx
  on public.import_orders (organization_id, status);

create index if not exists import_orders_org_expected_idx
  on public.import_orders (organization_id, expected_arrival);

create index if not exists import_order_items_order_idx
  on public.import_order_items (organization_id, order_id);

alter table public.import_orders enable row level security;
alter table public.import_order_items enable row level security;

drop policy if exists import_orders_all_app on public.import_orders;
drop policy if exists import_order_items_all_app on public.import_order_items;

create policy import_orders_all_app
on public.import_orders
for all
to public
using (organization_id is not null)
with check (organization_id is not null);

create policy import_order_items_all_app
on public.import_order_items
for all
to public
using (organization_id is not null)
with check (organization_id is not null);

grant select, insert, update, delete on public.import_orders to anon, authenticated;
grant select, insert, update, delete on public.import_order_items to anon, authenticated;
