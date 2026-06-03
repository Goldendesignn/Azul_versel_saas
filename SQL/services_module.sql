-- Azul Gestao - modulo de venda de servicos
-- Executar uma vez no Supabase do ambiente de teste.

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text,
  sale_price numeric not null default 0,
  cost_price numeric not null default 0,
  active boolean not null default true,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists idx_services_organization_id on public.services(organization_id);
create index if not exists idx_services_active on public.services(active);
create index if not exists idx_services_name on public.services(lower(name));

alter table public.services enable row level security;

grant select, insert, update, delete on public.services to anon, authenticated;

drop policy if exists services_select_org on public.services;
create policy services_select_org
on public.services
for select
to anon, authenticated
using (
  public.is_admin()
  or public.is_org_member(organization_id)
);

drop policy if exists services_insert_org on public.services;
create policy services_insert_org
on public.services
for insert
to anon, authenticated
with check (
  public.is_admin()
  or public.is_org_member(organization_id)
);

drop policy if exists services_update_org on public.services;
create policy services_update_org
on public.services
for update
to anon, authenticated
using (
  public.is_admin()
  or public.is_org_member(organization_id)
)
with check (
  public.is_admin()
  or public.is_org_member(organization_id)
);

drop policy if exists services_delete_org on public.services;
create policy services_delete_org
on public.services
for delete
to anon, authenticated
using (
  public.is_admin()
  or public.is_org_member(organization_id)
);
