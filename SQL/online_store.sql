create table if not exists public.online_store_settings (
  organization_id uuid primary key,
  active boolean not null default false,
  slug text unique,
  whatsapp_phone text,
  store_name text,
  welcome_message text,
  show_stock boolean not null default true,
  product_ids jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists idx_online_store_settings_slug
  on public.online_store_settings (slug)
  where active = true;

alter table public.online_store_settings enable row level security;

grant select, insert, update on public.online_store_settings to anon, authenticated;

drop policy if exists online_store_settings_manage_by_org on public.online_store_settings;
create policy online_store_settings_manage_by_org
on public.online_store_settings
for all
to public
using (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
)
with check (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
);

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
      'welcome_message', v_settings.welcome_message,
      'show_stock', v_settings.show_stock
    ),
    'products', v_products
  );
end;
$$;

grant execute on function public.get_online_store(uuid, text) to anon, authenticated;
