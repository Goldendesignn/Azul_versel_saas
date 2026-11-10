create table if not exists public.online_store_settings (
  organization_id uuid primary key,
  active boolean not null default false,
  slug text unique,
  whatsapp_phone text,
  store_name text,
  hero_title text,
  hero_slides jsonb not null default '[]'::jsonb,
  welcome_message text,
  theme_color text not null default '#0b3d91',
  font_family text not null default 'Arial, Helvetica, sans-serif',
  logo_url text,
  show_stock boolean not null default true,
  product_ids jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.online_store_settings
  add column if not exists hero_title text;

alter table public.online_store_settings
  add column if not exists hero_slides jsonb not null default '[]'::jsonb;

alter table public.online_store_settings
  add column if not exists theme_color text not null default '#0b3d91';

alter table public.online_store_settings
  add column if not exists font_family text not null default 'Arial, Helvetica, sans-serif';

alter table public.online_store_settings
  add column if not exists logo_url text;

alter table public.products
  add column if not exists description text;

create index if not exists idx_online_store_settings_slug
  on public.online_store_settings (slug)
  where active = true;

alter table public.online_store_settings enable row level security;

grant select on public.online_store_settings to anon, authenticated;
grant insert, update on public.online_store_settings to authenticated;

drop policy if exists online_store_settings_manage_by_org on public.online_store_settings;
drop policy if exists online_store_settings_member_manage on public.online_store_settings;
create policy online_store_settings_manage_by_org
on public.online_store_settings
for all
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists online_store_settings_public_active on public.online_store_settings;
create policy online_store_settings_public_active
on public.online_store_settings
for select
to public
using (active = true);

create or replace function public.touch_online_store_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_online_store_settings on public.online_store_settings;
create trigger trg_touch_online_store_settings
before update on public.online_store_settings
for each row
execute function public.touch_online_store_settings_updated_at();

create or replace function public.get_online_store(
  p_org_id uuid default null,
  p_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.online_store_settings%rowtype;
  v_products jsonb;
begin
  select *
    into v_settings
  from public.online_store_settings s
  where s.active = true
    and (
      (p_org_id is not null and s.organization_id = p_org_id)
      or
      (p_slug is not null and lower(s.slug) = lower(p_slug))
    )
  limit 1;

  if v_settings.organization_id is null then
    return jsonb_build_object(
      'ok', false,
      'message', 'Loja indisponivel'
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'category', p.category,
    'sale_price', p.sale_price,
    'stock_shop', p.stock_shop,
    'photo', p.photo,
    'code', p.code,
    'description', p.description,
    'variation', p.variation,
    'variations', p.variations
  ) order by p.name asc), '[]'::jsonb)
    into v_products
  from public.products p
  where p.organization_id = v_settings.organization_id
    and p.id::text in (select jsonb_array_elements_text(v_settings.product_ids))
    and coalesce(p.sale_price, 0) > 0;

  return jsonb_build_object(
    'ok', true,
    'store', jsonb_build_object(
      'organization_id', v_settings.organization_id,
      'slug', v_settings.slug,
      'active', v_settings.active,
      'whatsapp_phone', v_settings.whatsapp_phone,
      'store_name', v_settings.store_name,
      'hero_title', v_settings.hero_title,
      'hero_slides', v_settings.hero_slides,
      'welcome_message', v_settings.welcome_message,
      'theme_color', v_settings.theme_color,
      'font_family', v_settings.font_family,
      'logo_url', v_settings.logo_url,
      'show_stock', v_settings.show_stock
    ),
    'products', v_products
  );
end;
$$;

grant execute on function public.get_online_store(uuid, text) to anon, authenticated;

create table if not exists public.online_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_number text not null unique,
  customer_name text not null,
  customer_phone text not null,
  customer_address text not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'planned', 'preparing', 'delivered', 'canceled')),
  scheduled_for timestamp with time zone,
  reminder_before_minutes integer not null default 60,
  reminder_sent_at timestamp with time zone,
  delivery_note text,
  priority text not null default 'normal'
    check (priority in ('normal', 'urgent')),
  total numeric not null default 0,
  source text not null default 'whatsapp',
  whatsapp_message text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.online_orders
  drop constraint if exists online_orders_status_check;

alter table public.online_orders
  add constraint online_orders_status_check
  check (status in ('pending', 'confirmed', 'planned', 'preparing', 'delivered', 'canceled'));

alter table public.online_orders
  add column if not exists scheduled_for timestamp with time zone;

alter table public.online_orders
  add column if not exists reminder_before_minutes integer not null default 60;

alter table public.online_orders
  add column if not exists reminder_sent_at timestamp with time zone;

alter table public.online_orders
  add column if not exists delivery_note text;

alter table public.online_orders
  add column if not exists priority text not null default 'normal';

alter table public.online_orders
  drop constraint if exists online_orders_priority_check;

alter table public.online_orders
  add constraint online_orders_priority_check
  check (priority in ('normal', 'urgent'));

create table if not exists public.online_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.online_orders(id) on delete cascade,
  organization_id uuid not null,
  product_id uuid,
  product_name text not null,
  code text,
  variation text,
  quantity integer not null check (quantity > 0),
  unit_price numeric not null default 0,
  total numeric not null default 0,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_online_orders_org_created
  on public.online_orders (organization_id, created_at desc);

create index if not exists idx_online_orders_org_status
  on public.online_orders (organization_id, status);

create index if not exists idx_online_orders_org_scheduled
  on public.online_orders (organization_id, scheduled_for)
  where scheduled_for is not null;

create index if not exists idx_online_order_items_order
  on public.online_order_items (order_id);

alter table public.online_orders enable row level security;
alter table public.online_order_items enable row level security;

revoke all on public.online_orders from anon;
revoke all on public.online_order_items from anon;
grant select, update on public.online_orders to authenticated;
grant select on public.online_order_items to authenticated;

drop policy if exists online_orders_manage_by_org on public.online_orders;
drop policy if exists online_orders_member_manage on public.online_orders;
create policy online_orders_manage_by_org
on public.online_orders
for all
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists online_order_items_select_by_org on public.online_order_items;
drop policy if exists online_order_items_member_select on public.online_order_items;
create policy online_order_items_select_by_org
on public.online_order_items
for select
to authenticated
using (public.is_org_member(organization_id));

create or replace function public.touch_online_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_online_orders on public.online_orders;
create trigger trg_touch_online_orders
before update on public.online_orders
for each row
execute function public.touch_online_orders_updated_at();

create or replace function public.create_online_order(
  p_org_id uuid default null,
  p_slug text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_address text default null,
  p_items jsonb default '[]'::jsonb,
  p_whatsapp_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.online_store_settings%rowtype;
  v_order_id uuid;
  v_order_number text;
  v_total numeric := 0;
begin
  if coalesce(trim(p_customer_name), '') = ''
    or coalesce(trim(p_customer_phone), '') = ''
    or coalesce(trim(p_customer_address), '') = '' then
    return jsonb_build_object('ok', false, 'message', 'Dados do cliente incompletos');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'message', 'Carrinho vazio');
  end if;

  select *
    into v_settings
  from public.online_store_settings s
  where s.active = true
    and (
      (p_org_id is not null and s.organization_id = p_org_id)
      or
      (p_slug is not null and lower(s.slug) = lower(p_slug))
    )
  limit 1;

  if v_settings.organization_id is null then
    return jsonb_build_object('ok', false, 'message', 'Loja indisponivel');
  end if;

  v_order_number := 'ON-' ||
    to_char(now(), 'YYMMDD-HH24MISS') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));

  insert into public.online_orders (
    organization_id,
    order_number,
    customer_name,
    customer_phone,
    customer_address,
    status,
    source,
    whatsapp_message
  )
  values (
    v_settings.organization_id,
    v_order_number,
    trim(p_customer_name),
    trim(p_customer_phone),
    trim(p_customer_address),
    'pending',
    'whatsapp',
    p_whatsapp_message
  )
  returning id into v_order_id;

  with requested_raw as (
    select
      nullif(item->>'product_id', '')::uuid as product_id,
      greatest(1, coalesce(nullif(item->>'quantity', '')::integer, 1)) as quantity,
      nullif(trim(item->>'variation'), '') as variation
    from jsonb_array_elements(p_items) item
    where nullif(item->>'product_id', '') is not null
  ),
  requested as (
    select product_id, variation, sum(quantity)::integer as quantity
    from requested_raw
    group by product_id, variation
  ),
  inserted as (
    insert into public.online_order_items (
      order_id,
      organization_id,
      product_id,
      product_name,
      code,
      variation,
      quantity,
      unit_price,
      total
    )
    select
      v_order_id,
      v_settings.organization_id,
      p.id,
      p.name,
      p.code,
      coalesce(r.variation, p.variation),
      r.quantity,
      coalesce(p.sale_price, 0),
      r.quantity * coalesce(p.sale_price, 0)
    from requested r
    join public.products p on p.id = r.product_id
    where p.organization_id = v_settings.organization_id
      and p.id::text in (select jsonb_array_elements_text(v_settings.product_ids))
      and coalesce(p.sale_price, 0) > 0
    returning total
  )
  select coalesce(sum(total), 0) into v_total
  from inserted;

  if v_total <= 0 then
    delete from public.online_orders where id = v_order_id;
    return jsonb_build_object('ok', false, 'message', 'Produtos indisponiveis');
  end if;

  update public.online_orders
  set total = v_total
  where id = v_order_id;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', v_order_number,
      'total', v_total,
      'status', 'pending'
    )
  );
end;
$$;

revoke all on function public.create_online_order(uuid, text, text, text, text, jsonb, text) from public;
grant execute on function public.create_online_order(uuid, text, text, text, text, jsonb, text) to anon, authenticated;
