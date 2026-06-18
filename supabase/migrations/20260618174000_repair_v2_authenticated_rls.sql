-- Azul Gestao v2 - repair authenticated access after RLS hardening.
-- Keeps client data private by organization, while restoring access for logged-in users.

create or replace function public.azul_current_organization_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_org text;
begin
  v_org := coalesce(
    auth.jwt() -> 'user_metadata' ->> 'organization_id',
    auth.jwt() ->> 'organization_id',
    null
  );

  if v_org is null or trim(v_org) = '' then
    return null;
  end if;

  return v_org::uuid;
exception
  when others then
    return null;
end;
$$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    p_organization_id is not null
    and (
      exists (
        select 1
        from public.profiles p
        where p.organization_id = p_organization_id
          and coalesce(nullif(p.status, ''), 'active') in ('active', 'approved')
          and (
            p.auth_user_id = auth.uid()
            or lower(coalesce(p.email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
          )
      )
      or public.azul_current_organization_id() = p_organization_id
    );
$$;

revoke all on function public.azul_current_organization_id() from public;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.azul_current_organization_id() to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;

grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table if exists public.profiles
  add column if not exists auth_user_id uuid,
  add column if not exists organization_id uuid,
  add column if not exists name text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists role text not null default 'member',
  add column if not exists status text not null default 'active';

do $$
begin
  if to_regclass('public.profiles') is not null then
    update public.profiles p
    set auth_user_id = u.id
    from auth.users u
    where p.auth_user_id is null
      and nullif(trim(coalesce(p.email, '')), '') is not null
      and lower(trim(p.email)) = lower(trim(u.email));
  end if;
end $$;

do $$
declare
  v_table text;
  v_tables text[] := array[
    'products',
    'sales',
    'purchases',
    'expenses',
    'client_payments',
    'supplier_payments',
    'client_debts',
    'supplier_debts',
    'clients',
    'suppliers',
    'treasury_entries',
    'cash_movements',
    'accounting_entries',
    'accounting_lines',
    'services',
    'deliveries',
    'reseller_consignments',
    'stock_transfers',
    'import_orders',
    'import_order_items',
    'notifications',
    'action_audit_log',
    'hr_employees',
    'hr_attendance',
    'hr_payments',
    'online_store_settings',
    'online_orders',
    'pos_scan_sessions',
    'pos_scan_events'
  ];
begin
  foreach v_table in array v_tables loop
    if to_regclass(format('public.%I', v_table)) is not null
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = v_table
          and column_name = 'organization_id'
      )
    then
      execute format('alter table public.%I enable row level security', v_table);
      execute format('grant select, insert, update, delete on public.%I to authenticated', v_table);
      execute format('revoke all on public.%I from anon', v_table);

      execute format('drop policy if exists %I on public.%I', v_table || '_all_public', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_all_app', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_member_all', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_select_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_insert_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_update_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_delete_by_org', v_table);
      execute format('drop policy if exists %I on public.%I', v_table || '_authenticated_member_all', v_table);

      execute format(
        'create policy %I on public.%I for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id))',
        v_table || '_authenticated_member_all',
        v_table
      );
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.organizations') is not null then
    alter table public.organizations enable row level security;
    grant select, update on public.organizations to authenticated;
    drop policy if exists organizations_authenticated_member_select on public.organizations;
    drop policy if exists organizations_authenticated_member_update on public.organizations;
    create policy organizations_authenticated_member_select on public.organizations
      for select to authenticated
      using (public.is_org_member(id));
    create policy organizations_authenticated_member_update on public.organizations
      for update to authenticated
      using (public.is_org_member(id))
      with check (public.is_org_member(id));
  end if;

  if to_regclass('public.profiles') is not null then
    alter table public.profiles enable row level security;
    grant select, insert, update on public.profiles to authenticated;
    drop policy if exists profiles_member_select on public.profiles;
    drop policy if exists profiles_member_insert on public.profiles;
    drop policy if exists profiles_member_update on public.profiles;
    drop policy if exists profiles_authenticated_member_select on public.profiles;
    drop policy if exists profiles_authenticated_member_insert on public.profiles;
    drop policy if exists profiles_authenticated_member_update on public.profiles;

    create policy profiles_authenticated_member_select on public.profiles
      for select to authenticated
      using (
        public.is_org_member(organization_id)
        or auth_user_id = auth.uid()
        or lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      );

    create policy profiles_authenticated_member_insert on public.profiles
      for insert to authenticated
      with check (
        public.is_org_member(organization_id)
        or auth_user_id = auth.uid()
        or lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      );

    create policy profiles_authenticated_member_update on public.profiles
      for update to authenticated
      using (
        public.is_org_member(organization_id)
        or auth_user_id = auth.uid()
        or lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
      with check (
        public.is_org_member(organization_id)
        or auth_user_id = auth.uid()
        or lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      );
  end if;
end $$;

do $$
begin
  if to_regclass('public.sale_items') is not null then
    alter table public.sale_items enable row level security;
    grant select, insert, update, delete on public.sale_items to authenticated;
    revoke all on public.sale_items from anon;
    drop policy if exists sale_items_member_all on public.sale_items;
    drop policy if exists sale_items_authenticated_member_all on public.sale_items;
    create policy sale_items_authenticated_member_all on public.sale_items
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

  if to_regclass('public.purchase_items') is not null then
    alter table public.purchase_items enable row level security;
    grant select, insert, update, delete on public.purchase_items to authenticated;
    revoke all on public.purchase_items from anon;
    drop policy if exists purchase_items_member_all on public.purchase_items;
    drop policy if exists purchase_items_authenticated_member_all on public.purchase_items;
    create policy purchase_items_authenticated_member_all on public.purchase_items
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

  if to_regclass('public.reseller_consignment_items') is not null then
    alter table public.reseller_consignment_items enable row level security;
    grant select, insert, update, delete on public.reseller_consignment_items to authenticated;
    revoke all on public.reseller_consignment_items from anon;
    drop policy if exists reseller_items_member_all on public.reseller_consignment_items;
    drop policy if exists reseller_items_authenticated_member_all on public.reseller_consignment_items;
    create policy reseller_items_authenticated_member_all on public.reseller_consignment_items
      for all to authenticated
      using (
        exists (
          select 1 from public.reseller_consignments c
          where c.id = reseller_consignment_items.consignment_id
            and public.is_org_member(c.organization_id)
        )
      )
      with check (
        exists (
          select 1 from public.reseller_consignments c
          where c.id = reseller_consignment_items.consignment_id
            and public.is_org_member(c.organization_id)
        )
      );
  end if;
end $$;

do $$
declare
  v_function record;
  v_functions text[] := array[
    'get_login_profile_for_org',
    'get_login_profile_v2',
    'ensure_first_owner_profile',
    'touch_team_user',
    'get_organization_team',
    'admin_list_clients'
  ];
begin
  for v_function in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (v_functions)
  loop
    execute format('grant execute on function %s to authenticated', v_function.signature);
  end loop;
end $$;
