-- Add product measurement units and allow decimal stock quantities.
-- This supports businesses that sell by meter, liter, kg, roll, etc.

alter table if exists public.products
  add column if not exists unit text not null default 'unidade';

alter table if exists public.purchase_items
  add column if not exists unit text not null default 'unidade';

alter table if exists public.sale_items
  add column if not exists unit text not null default 'unidade';

alter table if exists public.products
  alter column stock_warehouse type numeric using coalesce(stock_warehouse, 0)::numeric,
  alter column stock_shop type numeric using coalesce(stock_shop, 0)::numeric,
  alter column min_stock type numeric using coalesce(min_stock, 0)::numeric;

alter table if exists public.purchase_items
  alter column quantity type numeric using coalesce(quantity, 0)::numeric;

alter table if exists public.sale_items
  alter column quantity type numeric using coalesce(quantity, 0)::numeric;

do $$
begin
  if to_regclass('public.products') is not null then
    update public.products
    set unit = 'unidade'
    where unit is null or trim(unit) = '';
  end if;

  if to_regclass('public.purchase_items') is not null then
    update public.purchase_items
    set unit = 'unidade'
    where unit is null or trim(unit) = '';
  end if;

  if to_regclass('public.sale_items') is not null then
    update public.sale_items
    set unit = 'unidade'
    where unit is null or trim(unit) = '';
  end if;
end $$;

create or replace function public.create_purchase_for_org(
  p_organization_id uuid,
  p_supplier text,
  p_total numeric,
  p_paid_amount numeric,
  p_remaining_amount numeric,
  p_is_credit boolean,
  p_created_at timestamp with time zone,
  p_items jsonb
)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.purchases;
  v_item jsonb;
begin
  if p_organization_id is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;

  if not public.is_org_member(p_organization_id) then
    raise exception 'ORG_ACCESS_DENIED';
  end if;

  if nullif(trim(coalesce(p_supplier, '')), '') is null then
    raise exception 'SUPPLIER_REQUIRED';
  end if;

  insert into public.purchases (
    organization_id, supplier, total, paid_amount, remaining_amount, is_credit, created_at, created_by, user_name
  )
  values (
    p_organization_id,
    trim(p_supplier),
    coalesce(p_total, 0),
    coalesce(p_paid_amount, 0),
    coalesce(p_remaining_amount, 0),
    coalesce(p_is_credit, false),
    coalesce(p_created_at, now()),
    auth.uid(),
    coalesce(auth.jwt() ->> 'email', '')
  )
  returning * into v_purchase;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.purchase_items (
      purchase_id, product_id, product_name, category, code, photo, variation, variations,
      purchase_price, sale_price, quantity, unit, supplier
    )
    values (
      v_purchase.id,
      nullif(v_item->>'product_id', '')::uuid,
      coalesce(v_item->>'product_name', ''),
      coalesce(v_item->>'category', ''),
      coalesce(v_item->>'code', ''),
      coalesce(v_item->>'photo', ''),
      coalesce(v_item->>'variation', ''),
      coalesce(v_item->'variations', '[]'::jsonb),
      coalesce(nullif(v_item->>'purchase_price', '')::numeric, 0),
      coalesce(nullif(v_item->>'sale_price', '')::numeric, 0),
      coalesce(nullif(v_item->>'quantity', '')::numeric, 0),
      coalesce(nullif(v_item->>'unit', ''), 'unidade'),
      coalesce(v_item->>'supplier', p_supplier)
    );
  end loop;

  return v_purchase;
end;
$$;

revoke all on function public.create_purchase_for_org(uuid, text, numeric, numeric, numeric, boolean, timestamp with time zone, jsonb) from public;
grant execute on function public.create_purchase_for_org(uuid, text, numeric, numeric, numeric, boolean, timestamp with time zone, jsonb) to authenticated;

notify pgrst, 'reload schema';
