alter table public.products
  add column if not exists description text;

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

revoke all on function public.get_online_store(uuid, text) from public;
grant execute on function public.get_online_store(uuid, text) to anon, authenticated;

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
