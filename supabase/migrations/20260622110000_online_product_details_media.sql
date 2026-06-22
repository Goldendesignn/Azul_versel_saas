create table if not exists public.online_product_details (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  public_name text,
  description text,
  online_price numeric,
  online_category text,
  featured boolean not null default false,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  user_name text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint online_product_details_org_product_unique unique (organization_id, product_id)
);

create table if not exists public.online_product_media (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image', 'video')),
  sort_order integer not null default 0,
  is_main boolean not null default false,
  created_by uuid default auth.uid(),
  user_name text,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_online_product_details_org
  on public.online_product_details (organization_id);

create index if not exists idx_online_product_media_org_product
  on public.online_product_media (organization_id, product_id, sort_order);

alter table public.online_product_details enable row level security;
alter table public.online_product_media enable row level security;

grant select, insert, update, delete on public.online_product_details to authenticated;
grant select, insert, update, delete on public.online_product_media to authenticated;

drop policy if exists online_product_details_member_all on public.online_product_details;
create policy online_product_details_member_all
on public.online_product_details
for all
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

drop policy if exists online_product_media_member_all on public.online_product_media;
create policy online_product_media_member_all
on public.online_product_media
for all
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create or replace function public.touch_online_product_details_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_online_product_details on public.online_product_details;
create trigger trg_touch_online_product_details
before update on public.online_product_details
for each row
execute function public.touch_online_product_details_updated_at();

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

  select coalesce(jsonb_agg(product_payload order by lower(product_payload->>'name') asc), '[]'::jsonb)
    into v_products
  from (
    select jsonb_build_object(
      'id', p.id,
      'name', coalesce(nullif(d.public_name, ''), p.name),
      'base_name', p.name,
      'category', coalesce(nullif(d.online_category, ''), p.category),
      'base_category', p.category,
      'sale_price', coalesce(d.online_price, p.sale_price),
      'base_sale_price', p.sale_price,
      'stock_shop', p.stock_shop,
      'photo', coalesce(nullif((
        select m.media_url
        from public.online_product_media m
        where m.organization_id = p.organization_id
          and m.product_id = p.id
          and m.media_type = 'image'
        order by m.is_main desc, m.sort_order asc, m.created_at asc
        limit 1
      ), ''), p.photo),
      'code', p.code,
      'description', coalesce(nullif(d.description, ''), p.description),
      'variation', p.variation,
      'variations', p.variations,
      'online_featured', coalesce(d.featured, false),
      'online_media', coalesce((
        select jsonb_agg(jsonb_build_object(
          'url', m.media_url,
          'type', m.media_type,
          'is_main', m.is_main,
          'sort_order', m.sort_order
        ) order by m.is_main desc, m.sort_order asc, m.created_at asc)
        from public.online_product_media m
        where m.organization_id = p.organization_id
          and m.product_id = p.id
      ), '[]'::jsonb)
    ) as product_payload
    from public.products p
    left join public.online_product_details d
      on d.organization_id = p.organization_id
     and d.product_id = p.id
     and d.active = true
    where p.organization_id = v_settings.organization_id
      and p.id::text in (select jsonb_array_elements_text(v_settings.product_ids))
      and coalesce(d.online_price, p.sale_price, 0) > 0
  ) rows;

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

revoke all on function public.get_online_store(uuid, text) from public;
grant execute on function public.get_online_store(uuid, text) to anon, authenticated;
