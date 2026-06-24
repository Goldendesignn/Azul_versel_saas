-- Azul Gestao v2 - Priority 01 stability and RLS repair.
-- Goal: authenticated users can reliably read/write only their organization data.
-- This migration is idempotent and avoids using user_metadata as an authority.

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles') then
    alter table public.profiles add column if not exists auth_user_id uuid;
    alter table public.profiles add column if not exists role text default 'member';
    alter table public.profiles add column if not exists status text default 'active';
  end if;
end $$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.organization_id = p_organization_id
      and coalesce(nullif(p.status, ''), 'active') = 'active'
      and (
        p.auth_user_id = auth.uid()
        or lower(trim(coalesce(p.email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      )
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

create or replace function public.is_org_owner(p_organization_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.organization_id = p_organization_id
      and coalesce(nullif(p.status, ''), 'active') = 'active'
      and coalesce(nullif(p.role, ''), 'member') = 'owner'
      and (
        p.auth_user_id = auth.uid()
        or lower(trim(coalesce(p.email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      )
  );
$$;

revoke all on function public.is_org_owner(uuid) from public;
grant execute on function public.is_org_owner(uuid) to authenticated;

grant usage on schema public to authenticated;

do $$
declare
  v_table text;
  v_policy record;
  v_private_tables text[] := array[
    'products',
    'sales',
    'sale_items',
    'purchases',
    'purchase_items',
    'expenses',
    'clients',
    'client_debts',
    'client_payments',
    'suppliers',
    'supplier_payments',
    'treasury_entries',
    'accounting_entries',
    'accounting_lines',
    'services',
    'deliveries',
    'resellers',
    'reseller_consignments',
    'reseller_consignment_items',
    'stock_transfers',
    'stock_transfer_items',
    'import_orders',
    'import_order_items',
    'corrections_log',
    'action_audit_log',
    'notifications',
    'push_subscriptions',
    'quotes',
    'quote_items'
  ];
begin
  foreach v_table in array v_private_tables loop
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = v_table
        and table_type = 'BASE TABLE'
    ) then
      execute format('alter table public.%I enable row level security', v_table);
      execute format('revoke all on public.%I from anon', v_table);
      execute format('grant select, insert, update, delete on public.%I to authenticated', v_table);

      execute format('drop policy if exists %I on public.%I', v_table || '_all_public', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_all_app', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_select_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_insert_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_update_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_delete_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_member_all', v_table);

      for v_policy in
        select policyname
        from pg_policies
        where schemaname = 'public'
          and tablename = v_table
          and ('public' = any(roles) or 'anon' = any(roles))
      loop
        execute format('drop policy if exists %I on public.%I', v_policy.policyname, v_table);
      end loop;

      if exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = v_table
          and column_name = 'organization_id'
      ) then
        execute format(
          'create policy %I on public.%I for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id))',
          v_table || '_member_all',
          v_table
        );
      end if;
    end if;
  end loop;
end $$;

-- Child tables without organization_id: authorize through their parent.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'sale_items')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sale_items' and column_name = 'sale_id')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sale_items' and column_name = 'organization_id') then
    drop policy if exists sale_items_member_all on public.sale_items;
    create policy sale_items_member_all on public.sale_items
      for all to authenticated
      using (
        exists (
          select 1 from public.sales s
          where s.id = sale_items.sale_id
            and public.is_org_member(s.organization_id)
        )
      )
      with check (
        exists (
          select 1 from public.sales s
          where s.id = sale_items.sale_id
            and public.is_org_member(s.organization_id)
        )
      );
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'purchase_items')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'purchase_items' and column_name = 'purchase_id')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'purchase_items' and column_name = 'organization_id') then
    drop policy if exists purchase_items_member_all on public.purchase_items;
    create policy purchase_items_member_all on public.purchase_items
      for all to authenticated
      using (
        exists (
          select 1 from public.purchases p
          where p.id = purchase_items.purchase_id
            and public.is_org_member(p.organization_id)
        )
      )
      with check (
        exists (
          select 1 from public.purchases p
          where p.id = purchase_items.purchase_id
            and public.is_org_member(p.organization_id)
        )
      );
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'reseller_consignment_items')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reseller_consignment_items' and column_name = 'consignment_id')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reseller_consignment_items' and column_name = 'organization_id') then
    drop policy if exists reseller_consignment_items_member_all on public.reseller_consignment_items;
    create policy reseller_consignment_items_member_all on public.reseller_consignment_items
      for all to authenticated
      using (
        exists (
          select 1 from public.reseller_consignments rc
          where rc.id = reseller_consignment_items.consignment_id
            and public.is_org_member(rc.organization_id)
        )
      )
      with check (
        exists (
          select 1 from public.reseller_consignments rc
          where rc.id = reseller_consignment_items.consignment_id
            and public.is_org_member(rc.organization_id)
        )
      );
  end if;
end $$;

-- Profiles are not public, but every active member can see the team of the same organization.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles') then
    alter table public.profiles enable row level security;
    revoke all on public.profiles from anon;
    grant select, update on public.profiles to authenticated;

    drop policy if exists profiles_all_public on public.profiles;
    drop policy if exists profiles_member_select on public.profiles;
    drop policy if exists profiles_self_update on public.profiles;

    create policy profiles_member_select on public.profiles
      for select to authenticated
      using (
        public.is_org_member(organization_id)
        or auth_user_id = auth.uid()
        or lower(trim(coalesce(email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      );

    create policy profiles_self_update on public.profiles
      for update to authenticated
      using (
        auth_user_id = auth.uid()
        or lower(trim(coalesce(email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      )
      with check (
        auth_user_id = auth.uid()
        or lower(trim(coalesce(email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      );
  end if;
end $$;

-- Keep old accounts linked to auth.users so RLS survives refresh.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'auth_user_id') then
    update public.profiles p
    set auth_user_id = u.id
    from auth.users u
    where p.auth_user_id is null
      and nullif(trim(coalesce(p.email, '')), '') is not null
      and lower(trim(p.email)) = lower(trim(u.email));
  end if;
end $$;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'auth_user_id') then
    create index if not exists profiles_auth_user_id_idx on public.profiles (auth_user_id);
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'organization_id')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'email') then
    create index if not exists profiles_org_email_idx on public.profiles (organization_id, lower(email));
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sales' and column_name = 'organization_id')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sales' and column_name = 'sale_date') then
    create index if not exists sales_org_date_idx on public.sales (organization_id, sale_date desc);
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'organization_id')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'name') then
    create index if not exists products_org_name_idx on public.products (organization_id, lower(name));
  end if;
end $$;
