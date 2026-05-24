create extension if not exists pgcrypto;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_user_id uuid,
  actor_name text,
  actor_role text,
  action_type text not null,
  title text not null,
  message text,
  source_type text,
  source_id uuid,
  target_roles text[] not null default array['owner','manager'],
  read_by jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create index if not exists notifications_org_created_idx
  on public.notifications (organization_id, created_at desc);

create index if not exists notifications_target_roles_idx
  on public.notifications using gin (target_roles);

alter table public.notifications enable row level security;

drop policy if exists notifications_public_all on public.notifications;
create policy notifications_public_all
on public.notifications
for all
to public
using (true)
with check (true);
