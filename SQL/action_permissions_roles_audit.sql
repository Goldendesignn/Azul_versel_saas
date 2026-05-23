create extension if not exists pgcrypto;

alter table public.sales
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.purchases
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.expenses
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.client_payments
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.supplier_payments
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.corrections_log
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.treasury_entries
  add column if not exists created_by uuid,
  add column if not exists user_name text;

create index if not exists sales_created_by_idx
  on public.sales (organization_id, created_by);

create index if not exists purchases_created_by_idx
  on public.purchases (organization_id, created_by);

create index if not exists expenses_created_by_idx
  on public.expenses (organization_id, created_by);

create index if not exists client_payments_created_by_idx
  on public.client_payments (organization_id, created_by);

create index if not exists supplier_payments_created_by_idx
  on public.supplier_payments (organization_id, created_by);

create index if not exists corrections_log_created_by_idx
  on public.corrections_log (organization_id, created_by);

create index if not exists treasury_entries_created_by_idx
  on public.treasury_entries (organization_id, created_by);

create table if not exists public.role_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  code text not null,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists role_definitions_org_code_idx
  on public.role_definitions (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(code)
  );

create table if not exists public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  role_code text not null,
  permission text not null,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists role_permissions_org_role_permission_idx
  on public.role_permissions (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(role_code),
    lower(permission)
  );

create table if not exists public.action_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  actor_user_id uuid,
  actor_name text,
  actor_email text,
  actor_role text,
  device_id text,
  action text not null,
  module text,
  status text not null default 'success',
  source_table text,
  source_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create index if not exists action_audit_org_created_idx
  on public.action_audit_log (organization_id, created_at desc);

create index if not exists action_audit_actor_idx
  on public.action_audit_log (organization_id, actor_user_id, created_at desc);

alter table public.role_definitions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.action_audit_log enable row level security;

drop policy if exists role_definitions_public_all on public.role_definitions;
create policy role_definitions_public_all
on public.role_definitions
for all
to public
using (true)
with check (true);

drop policy if exists role_permissions_public_all on public.role_permissions;
create policy role_permissions_public_all
on public.role_permissions
for all
to public
using (true)
with check (true);

drop policy if exists action_audit_log_public_insert on public.action_audit_log;
create policy action_audit_log_public_insert
on public.action_audit_log
for insert
to public
with check (true);

drop policy if exists action_audit_log_public_select on public.action_audit_log;
create policy action_audit_log_public_select
on public.action_audit_log
for select
to public
using (true);

insert into public.role_definitions (organization_id, code, name, description, is_system)
values
  (null, 'owner', 'Proprietario', 'Acesso completo a loja.', true),
  (null, 'manager', 'Gerente', 'Gestao operacional da loja.', true),
  (null, 'cashier', 'Caixa', 'Vendas, clientes e recebimentos.', true),
  (null, 'stock', 'Stock', 'Compras, fornecedores e movimento de stock.', true),
  (null, 'accountant', 'Contabilista', 'Tesouraria, despesas e contabilidade.', true),
  (null, 'readonly', 'Leitura', 'Consulta sem alteracao.', true),
  (null, 'member', 'Utilizador', 'Utilizador sem permissoes especiais.', true)
on conflict do nothing;

insert into public.role_permissions (organization_id, role_code, permission)
values
  (null, 'owner', '*'),
  (null, 'manager', '*'),

  (null, 'cashier', 'page:dashboard'),
  (null, 'cashier', 'page:venda'),
  (null, 'cashier', 'page:clientes'),
  (null, 'cashier', 'page:tresorerie'),
  (null, 'cashier', 'sale:create'),
  (null, 'cashier', 'sale:view'),
  (null, 'cashier', 'client_payment:create'),
  (null, 'cashier', 'client:view'),

  (null, 'stock', 'page:dashboard'),
  (null, 'stock', 'page:achat'),
  (null, 'stock', 'page:transfert'),
  (null, 'stock', 'page:forn'),
  (null, 'stock', 'purchase:create'),
  (null, 'stock', 'purchase:view'),
  (null, 'stock', 'stock:transfer'),
  (null, 'stock', 'supplier:view'),
  (null, 'stock', 'supplier_payment:create'),
  (null, 'stock', 'import:create'),

  (null, 'accountant', 'page:dashboard'),
  (null, 'accountant', 'page:depenses'),
  (null, 'accountant', 'page:tresorerie'),
  (null, 'accountant', 'page:comptabilite'),
  (null, 'accountant', 'page:corrections'),
  (null, 'accountant', 'expense:create'),
  (null, 'accountant', 'expense:view'),
  (null, 'accountant', 'client_payment:create'),
  (null, 'accountant', 'supplier_payment:create'),
  (null, 'accountant', 'correction:create'),
  (null, 'accountant', 'accounting:view'),
  (null, 'accountant', 'cash:view'),
  (null, 'accountant', 'page:rh'),
  (null, 'accountant', 'hr:create'),
  (null, 'accountant', 'hr:view'),

  (null, 'readonly', 'page:dashboard'),
  (null, 'readonly', 'page:transfert'),
  (null, 'readonly', 'page:clientes'),
  (null, 'readonly', 'page:tresorerie'),
  (null, 'readonly', 'page:comptabilite'),
  (null, 'readonly', 'sale:view'),
  (null, 'readonly', 'purchase:view'),
  (null, 'readonly', 'expense:view'),
  (null, 'readonly', 'cash:view'),
  (null, 'readonly', 'accounting:view'),
  (null, 'readonly', 'page:rh'),
  (null, 'readonly', 'hr:view'),

  (null, 'member', 'page:dashboard')
on conflict do nothing;

drop function if exists public.get_role_catalog(uuid);

create or replace function public.get_role_catalog(p_organization_id uuid)
returns table (
  code text,
  name text,
  description text,
  is_system boolean,
  permissions text[]
)
language sql
security definer
set search_path = public
as $$
  select
    rd.code,
    rd.name,
    rd.description,
    rd.is_system,
    coalesce(
      array_agg(distinct rp.permission) filter (where rp.permission is not null),
      array[]::text[]
    ) as permissions
  from public.role_definitions rd
  left join public.role_permissions rp
    on lower(rp.role_code) = lower(rd.code)
   and (
     rp.organization_id is null
     or rp.organization_id = p_organization_id
   )
  where rd.organization_id is null
     or rd.organization_id = p_organization_id
  group by rd.code, rd.name, rd.description, rd.is_system
  order by rd.is_system desc, rd.name asc;
$$;

grant execute on function public.get_role_catalog(uuid) to authenticated, anon;

drop function if exists public.upsert_custom_role(uuid, text, text, text[]);

create or replace function public.upsert_custom_role(
  p_organization_id uuid,
  p_code text,
  p_name text,
  p_permissions text[]
)
returns table (
  code text,
  name text,
  permissions text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_code text := lower(regexp_replace(trim(coalesce(p_code, '')), '[^a-z0-9_]+', '_', 'g'));
begin
  if p_organization_id is null or v_code = '' or trim(coalesce(p_name, '')) = '' then
    raise exception 'INVALID_ROLE';
  end if;

  if v_code in ('owner', 'manager', 'cashier', 'stock', 'accountant', 'readonly', 'member') then
    raise exception 'SYSTEM_ROLE_LOCKED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.status, ''), 'active') = 'active'
    and (
      p.auth_user_id = auth.uid()
      or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  update public.role_definitions
  set
    name = trim(p_name),
    description = 'Role personalizado',
    is_system = false
  where organization_id = p_organization_id
    and lower(code) = v_code;

  if not found then
    insert into public.role_definitions (organization_id, code, name, description, is_system)
    values (p_organization_id, v_code, trim(p_name), 'Role personalizado', false);
  end if;

  delete from public.role_permissions
  where organization_id = p_organization_id
    and lower(role_code) = v_code;

  insert into public.role_permissions (organization_id, role_code, permission)
  select p_organization_id, v_code, distinct_permission
  from (
    select distinct unnest(coalesce(p_permissions, array[]::text[])) as distinct_permission
  ) p
  where trim(coalesce(distinct_permission, '')) <> '';

  return query
  select v_code, trim(p_name), coalesce(p_permissions, array[]::text[]);
end;
$$;

grant execute on function public.upsert_custom_role(uuid, text, text, text[]) to authenticated;

drop function if exists public.update_team_member_role_status(uuid, text, text, text);

create or replace function public.update_team_member_role_status(
  p_organization_id uuid,
  p_email text,
  p_role text,
  p_status text
)
returns table (
  email text,
  role text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := lower(trim(coalesce(p_role, 'member')));
  v_status text := lower(trim(coalesce(p_status, 'active')));
  v_active_owner_count integer;
  v_role_exists boolean;
begin
  if p_organization_id is null or v_email = '' then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  select exists (
    select 1
    from public.role_definitions rd
    where lower(rd.code) = v_role
      and (rd.organization_id is null or rd.organization_id = p_organization_id)
  ) into v_role_exists;

  if not coalesce(v_role_exists, false) then
    raise exception 'INVALID_ROLE';
  end if;

  if v_status not in ('active', 'pending', 'inactive', 'suspended', 'blocked') then
    raise exception 'INVALID_STATUS';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.status, ''), 'active') = 'active'
    and (
      p.auth_user_id = auth.uid()
      or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_target_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_target_role is null then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_target_role = 'owner' and (v_role <> 'owner' or v_status <> 'active') then
    select count(*)
      into v_active_owner_count
    from public.profiles p
    where p.organization_id = p_organization_id
      and lower(p.email) <> v_email
      and coalesce(nullif(p.role, ''), 'member') = 'owner'
      and coalesce(nullif(p.status, ''), 'active') = 'active';

    if coalesce(v_active_owner_count, 0) < 1 then
      raise exception 'LAST_OWNER_REQUIRED';
    end if;
  end if;

  update public.profiles p
  set
    role = v_role,
    status = v_status,
    last_seen_at = coalesce(p.last_seen_at, now())
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email;

  return query
  select p.email, p.role, p.status
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;
end;
$$;

grant execute on function public.update_team_member_role_status(uuid, text, text, text) to authenticated;
