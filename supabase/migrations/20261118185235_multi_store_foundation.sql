-- Multi-store foundation. An organization remains the legal company; stores are its outlets.
create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  code text not null check (code ~ '^[A-Z0-9-]{2,16}$'),
  address text not null default '',
  phone text not null default '',
  active boolean not null default true,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create unique index if not exists stores_one_primary_per_organization_idx
  on public.stores (organization_id) where is_primary;
create index if not exists stores_organization_active_idx
  on public.stores (organization_id, active, name);

create table if not exists public.store_members (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null,
  active boolean not null default true,
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create index if not exists store_members_user_active_idx
  on public.store_members (user_id, active, store_id);

create table if not exists public.store_product_stocks (
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity numeric(14,3) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (store_id, product_id)
);

create index if not exists store_product_stocks_product_idx
  on public.store_product_stocks (product_id, store_id);

-- Existing customers keep their behaviour: every company receives one primary store.
insert into public.stores (organization_id, name, code, is_primary)
select o.id, 'Boutique principal', 'PRINCIPAL', true
from public.organizations o
where not exists (
  select 1 from public.stores s where s.organization_id = o.id
)
on conflict (organization_id, code) do nothing;

-- Existing active staff keep access to the former single store.
insert into public.store_members (store_id, user_id, active)
select s.id, p.auth_user_id, true
from public.stores s
join public.profiles p on p.organization_id = s.organization_id
where s.is_primary
  and p.auth_user_id is not null
  and coalesce(lower(p.status), 'active') = 'active'
on conflict (store_id, user_id) do nothing;

insert into public.store_product_stocks (store_id, product_id, quantity)
select s.id, p.id, coalesce(p.stock_shop, 0)
from public.products p
join public.stores s on s.organization_id = p.organization_id and s.is_primary
on conflict (store_id, product_id) do nothing;

create or replace function public.can_access_store(p_store_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.stores s
    join public.profiles p on p.organization_id = s.organization_id and p.auth_user_id = auth.uid()
    where s.id = p_store_id
      and s.active
      and coalesce(lower(p.status), 'active') = 'active'
      and (
        lower(coalesce(p.role, 'member')) in ('owner', 'manager')
        or exists (
          select 1 from public.store_members sm
          where sm.store_id = s.id and sm.user_id = auth.uid() and sm.active
        )
      )
  );
$$;
revoke all on function public.can_access_store(uuid) from public;

create or replace function public.can_manage_store(p_store_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.stores s
    join public.profiles p on p.organization_id = s.organization_id and p.auth_user_id = auth.uid()
    where s.id = p_store_id
      and coalesce(lower(p.status), 'active') = 'active'
      and lower(coalesce(p.role, 'member')) in ('owner', 'manager')
  );
$$;
revoke all on function public.can_manage_store(uuid) from public;

alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.store_product_stocks enable row level security;
revoke all on public.stores, public.store_members, public.store_product_stocks from anon;
grant select on public.stores, public.store_members, public.store_product_stocks to authenticated;

create policy stores_member_select on public.stores for select to authenticated
  using (public.can_access_store(id));
create policy store_members_member_select on public.store_members for select to authenticated
  using (public.can_access_store(store_id));
create policy store_stocks_member_select on public.store_product_stocks for select to authenticated
  using (public.can_access_store(store_id));

create or replace function public.create_store(
  p_organization_id uuid,
  p_name text,
  p_code text,
  p_address text default '',
  p_phone text default ''
)
returns public.stores
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_store public.stores%rowtype;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.organization_id = p_organization_id and p.auth_user_id = auth.uid()
      and coalesce(lower(p.status), 'active') = 'active'
      and lower(coalesce(p.role, 'member')) in ('owner', 'manager')
  ) then raise exception 'Sem permissao para criar boutiques.'; end if;

  insert into public.stores (organization_id, name, code, address, phone)
  values (p_organization_id, btrim(p_name), upper(regexp_replace(btrim(p_code), '[^A-Za-z0-9-]', '', 'g')), btrim(coalesce(p_address, '')), btrim(coalesce(p_phone, '')))
  returning * into v_store;
  return v_store;
end;
$$;
revoke all on function public.create_store(uuid, text, text, text, text) from public;
grant execute on function public.create_store(uuid, text, text, text, text) to authenticated;

create or replace function public.set_store_member_access(
  p_store_id uuid,
  p_email text,
  p_active boolean
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_user_id uuid;
begin
  if not public.can_manage_store(p_store_id) then raise exception 'Sem permissao para gerir equipa desta boutique.'; end if;
  select p.auth_user_id into v_user_id
  from public.profiles p
  join public.stores s on s.organization_id = p.organization_id
  where s.id = p_store_id and lower(trim(coalesce(p.email, ''))) = lower(trim(coalesce(p_email, '')))
  limit 1;
  if v_user_id is null then raise exception 'Utilizador nao encontrado nesta empresa.'; end if;

  insert into public.store_members (store_id, user_id, active, assigned_by)
  values (p_store_id, v_user_id, coalesce(p_active, true), auth.uid())
  on conflict (store_id, user_id) do update
    set active = excluded.active, assigned_by = auth.uid(), updated_at = now();
end;
$$;
revoke all on function public.set_store_member_access(uuid, text, boolean) from public;
grant execute on function public.set_store_member_access(uuid, text, boolean) to authenticated;

-- Add store attribution to operational records. The trigger preserves compatibility for old client versions.
do $$
declare v_table text;
begin
  foreach v_table in array array['sales', 'purchases', 'expenses', 'cash_register_sessions', 'fiscal_documents', 'deliveries', 'online_orders'] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('alter table public.%I add column if not exists store_id uuid references public.stores(id) on delete restrict', v_table);
      -- Fiscal documents are legally immutable once issued. Keep their historical rows unchanged.
      if v_table <> 'fiscal_documents' then
        execute format($sql$
          update public.%I r set store_id = s.id
          from public.stores s
          where s.organization_id = r.organization_id and s.is_primary and r.store_id is null
        $sql$, v_table);
      end if;
      execute format('create index if not exists %I on public.%I (organization_id, store_id)', v_table || '_organization_store_idx', v_table);
    end if;
  end loop;
end;
$$;

create or replace function public.apply_store_scope()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_store_org uuid;
begin
  if new.store_id is null then
    if tg_table_name = 'fiscal_documents' and nullif(to_jsonb(new)->>'sale_id', '') is not null then
      select store_id into new.store_id
      from public.sales
      where id = (to_jsonb(new)->>'sale_id')::uuid;
    end if;

    if new.store_id is null then
    select id into new.store_id from public.stores
    where organization_id = new.organization_id and is_primary and active;
    end if;
  end if;
  select organization_id into v_store_org from public.stores where id = new.store_id and active;
  if v_store_org is null or v_store_org <> new.organization_id then
    raise exception 'A boutique escolhida nao pertence a esta empresa.';
  end if;
  if not public.can_access_store(new.store_id) then
    raise exception 'Sem acesso a esta boutique.';
  end if;
  return new;
end;
$$;
revoke all on function public.apply_store_scope() from public;

do $$
declare v_table text;
begin
  foreach v_table in array array['sales', 'purchases', 'expenses', 'cash_register_sessions', 'fiscal_documents', 'deliveries', 'online_orders'] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('drop trigger if exists %I on public.%I', v_table || '_apply_store_scope', v_table);
      if v_table = 'fiscal_documents' then
        execute format('create trigger %I before insert on public.%I for each row execute function public.apply_store_scope()', v_table || '_apply_store_scope', v_table);
      else
        execute format('create trigger %I before insert or update of organization_id, store_id on public.%I for each row execute function public.apply_store_scope()', v_table || '_apply_store_scope', v_table);
      end if;
    end if;
  end loop;
end;
$$;

-- Secure stock adjustments. Browser clients can read stock but cannot forge stock changes directly.
revoke insert, update, delete on public.store_product_stocks from authenticated;

create or replace function public.adjust_store_product_stock(
  p_store_id uuid,
  p_product_id uuid,
  p_delta numeric
)
returns numeric
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_quantity numeric;
begin
  if not public.can_access_store(p_store_id) then raise exception 'Sem acesso a esta boutique.'; end if;
  if not exists (
    select 1 from public.products p join public.stores s on s.organization_id = p.organization_id
    where p.id = p_product_id and s.id = p_store_id
  ) then raise exception 'Produto invalido para esta boutique.'; end if;

  insert into public.store_product_stocks (store_id, product_id, quantity)
  values (p_store_id, p_product_id, 0)
  on conflict (store_id, product_id) do nothing;

  update public.store_product_stocks
  set quantity = quantity + coalesce(p_delta, 0), updated_at = now()
  where store_id = p_store_id and product_id = p_product_id
    and quantity + coalesce(p_delta, 0) >= 0
  returning quantity into v_quantity;

  if v_quantity is null then raise exception 'Stock insuficiente nesta boutique.'; end if;
  return v_quantity;
end;
$$;
revoke all on function public.adjust_store_product_stock(uuid, uuid, numeric) from public;
grant execute on function public.adjust_store_product_stock(uuid, uuid, numeric) to authenticated;

create or replace function public.transfer_warehouse_to_store(
  p_store_id uuid,
  p_product_id uuid,
  p_quantity numeric
)
returns table (warehouse_before numeric, warehouse_after numeric, store_before numeric, store_after numeric)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_product public.products%rowtype; v_store_before numeric; v_store_after numeric;
begin
  if not public.can_access_store(p_store_id) then raise exception 'Sem acesso a esta boutique.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select p.* into v_product from public.products p join public.stores s on s.organization_id = p.organization_id
  where p.id = p_product_id and s.id = p_store_id for update of p;
  if not found then raise exception 'Produto invalido para esta boutique.'; end if;
  if coalesce(v_product.stock_warehouse, 0) < p_quantity then raise exception 'Stock de armazem insuficiente.'; end if;
  select quantity into v_store_before from public.store_product_stocks where store_id = p_store_id and product_id = p_product_id;
  v_store_before := coalesce(v_store_before, 0);
  update public.products set stock_warehouse = stock_warehouse - p_quantity where id = p_product_id;
  v_store_after := public.adjust_store_product_stock(p_store_id, p_product_id, p_quantity);
  return query select coalesce(v_product.stock_warehouse, 0), coalesce(v_product.stock_warehouse, 0) - p_quantity, v_store_before, v_store_after;
end;
$$;
revoke all on function public.transfer_warehouse_to_store(uuid, uuid, numeric) from public;
grant execute on function public.transfer_warehouse_to_store(uuid, uuid, numeric) to authenticated;

create or replace function public.create_purchase_for_org(
  p_organization_id uuid,
  p_store_id uuid,
  p_supplier text,
  p_total numeric,
  p_paid_amount numeric,
  p_remaining_amount numeric,
  p_is_credit boolean,
  p_created_at timestamp with time zone,
  p_items jsonb
)
returns public.purchases
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_purchase public.purchases; v_item jsonb; v_product_id uuid; v_quantity numeric;
begin
  if p_organization_id is null or not public.is_org_member(p_organization_id) then raise exception 'ORG_ACCESS_DENIED'; end if;
  if not public.can_access_store(p_store_id) then raise exception 'STORE_ACCESS_DENIED'; end if;
  if nullif(trim(coalesce(p_supplier, '')), '') is null then raise exception 'SUPPLIER_REQUIRED'; end if;
  insert into public.purchases (organization_id, store_id, supplier, total, paid_amount, remaining_amount, is_credit, created_at, created_by, user_name)
  values (p_organization_id, p_store_id, trim(p_supplier), coalesce(p_total, 0), coalesce(p_paid_amount, 0), coalesce(p_remaining_amount, 0), coalesce(p_is_credit, false), coalesce(p_created_at, now()), auth.uid(), coalesce(auth.jwt() ->> 'email', ''))
  returning * into v_purchase;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_quantity := coalesce(nullif(v_item->>'quantity', '')::numeric, 0);
    insert into public.purchase_items (purchase_id, product_id, product_name, category, code, photo, variation, variations, purchase_price, sale_price, quantity, unit, supplier)
    values (v_purchase.id, v_product_id, coalesce(v_item->>'product_name', ''), coalesce(v_item->>'category', ''), coalesce(v_item->>'code', ''), coalesce(v_item->>'photo', ''), coalesce(v_item->>'variation', ''), coalesce(v_item->'variations', '[]'::jsonb), coalesce(nullif(v_item->>'purchase_price', '')::numeric, 0), coalesce(nullif(v_item->>'sale_price', '')::numeric, 0), v_quantity, coalesce(nullif(v_item->>'unit', ''), 'unidade'), coalesce(v_item->>'supplier', p_supplier));
    if v_product_id is not null and v_quantity > 0 then
      perform public.adjust_store_product_stock(p_store_id, v_product_id, v_quantity);
    end if;
  end loop;
  return v_purchase;
end;
$$;
revoke all on function public.create_purchase_for_org(uuid, uuid, text, numeric, numeric, numeric, boolean, timestamp with time zone, jsonb) from public;
grant execute on function public.create_purchase_for_org(uuid, uuid, text, numeric, numeric, numeric, boolean, timestamp with time zone, jsonb) to authenticated;

create or replace function public.open_cash_register(
  p_organization_id uuid,
  p_store_id uuid,
  p_opening_amount numeric,
  p_actor_name text default null,
  p_access_code text default null
)
returns public.cash_register_sessions
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_session public.cash_register_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if p_organization_id is null or not public.is_org_member(p_organization_id) or not public.can_access_store(p_store_id) then raise exception 'Sem permissao para abrir caixa nesta boutique.'; end if;
  if not public.verify_cashier_access_code(p_organization_id, p_access_code) then raise exception 'Codigo de caixa invalido ou nao configurado.'; end if;
  if coalesce(p_opening_amount, -1) < 0 then raise exception 'O fundo inicial nao pode ser negativo.'; end if;
  if exists (select 1 from public.cash_register_sessions where organization_id = p_organization_id and opened_by = auth.uid() and status = 'open') then raise exception 'Ja existe um tour de caixa aberto para este utilizador.'; end if;
  insert into public.cash_register_sessions (organization_id, store_id, opened_by, opened_by_name, opening_amount)
  values (p_organization_id, p_store_id, auth.uid(), public.cash_register_actor_name(p_actor_name), coalesce(p_opening_amount, 0))
  returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.open_cash_register(uuid, uuid, numeric, text, text) from public;
grant execute on function public.open_cash_register(uuid, uuid, numeric, text, text) to authenticated;

create or replace function public.validate_cash_register_sale_session()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_session public.cash_register_sessions%rowtype;
begin
  if new.cash_register_session_id is null then return new; end if;
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria para associar uma venda a caixa.'; end if;
  select * into v_session from public.cash_register_sessions where id = new.cash_register_session_id for share;
  if not found or v_session.organization_id <> new.organization_id or v_session.store_id <> new.store_id then raise exception 'Tour de caixa invalido para esta boutique.'; end if;
  if v_session.status <> 'open' then raise exception 'Nao e possivel registar uma venda num tour de caixa fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'A venda deve usar o tour aberto pelo proprio caixa.'; end if;
  return new;
end;
$$;
revoke all on function public.validate_cash_register_sale_session() from public;

drop trigger if exists sales_validate_cash_register_session on public.sales;
create trigger sales_validate_cash_register_session
before insert or update of cash_register_session_id, store_id on public.sales
for each row execute function public.validate_cash_register_sale_session();

notify pgrst, 'reload schema';
