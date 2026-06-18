alter table public.online_store_settings
  add column if not exists hero_slides jsonb not null default '[]'::jsonb;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'online-store-assets',
  'online-store-assets',
  true,
  6291456,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists online_store_assets_public_read on storage.objects;
create policy online_store_assets_public_read
on storage.objects
for select
to public
using (bucket_id = 'online-store-assets');

drop policy if exists online_store_assets_insert_by_org on storage.objects;
create policy online_store_assets_insert_by_org
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists online_store_assets_update_by_org on storage.objects;
create policy online_store_assets_update_by_org
on storage.objects
for update
to authenticated
using (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists online_store_assets_delete_by_org on storage.objects;
create policy online_store_assets_delete_by_org
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'online-store-assets'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

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
