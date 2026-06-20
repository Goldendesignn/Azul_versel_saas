-- Azul Gestao V2
-- Corrige os Web Push para ambientes reais:
-- o mesmo navegador pode ser usado em varias organizacoes/clientes.
-- A chave unica antiga apenas por endpoint bloqueava novas subscricoes
-- quando o endpoint ja existia noutra organizacao.

create extension if not exists pgcrypto;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid,
  user_name text,
  user_email text,
  user_role text,
  device_id text,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  browser_name text,
  active boolean not null default true,
  last_seen_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now()
);

drop index if exists public.push_subscriptions_endpoint_key;

create unique index if not exists push_subscriptions_org_endpoint_key
  on public.push_subscriptions (organization_id, endpoint);

create index if not exists push_subscriptions_org_active_idx
  on public.push_subscriptions (organization_id, active);

create index if not exists push_subscriptions_org_role_active_idx
  on public.push_subscriptions (organization_id, user_role, active);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_public_select on public.push_subscriptions;
drop policy if exists push_subscriptions_public_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_public_update on public.push_subscriptions;
drop policy if exists push_subscriptions_member_select on public.push_subscriptions;
drop policy if exists push_subscriptions_member_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_member_update on public.push_subscriptions;

create policy push_subscriptions_member_select
on public.push_subscriptions
for select
to authenticated
using (public.is_org_member(organization_id));

create policy push_subscriptions_member_insert
on public.push_subscriptions
for insert
to authenticated
with check (public.is_org_member(organization_id));

create policy push_subscriptions_member_update
on public.push_subscriptions
for update
to authenticated
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

revoke all on public.push_subscriptions from anon;
grant select, insert, update on public.push_subscriptions to authenticated;

notify pgrst, 'reload schema';
