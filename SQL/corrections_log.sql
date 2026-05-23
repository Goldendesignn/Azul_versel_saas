create table if not exists public.corrections_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  source_type text not null,
  source_id uuid not null,
  correction_type text not null default 'cancel',
  correction_id uuid,
  reason text,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create index if not exists corrections_log_org_idx
  on public.corrections_log (organization_id, created_at desc);

create index if not exists corrections_log_source_idx
  on public.corrections_log (source_type, source_id);

alter table public.corrections_log enable row level security;

drop policy if exists corrections_log_select_public on public.corrections_log;
drop policy if exists corrections_log_insert_public on public.corrections_log;

create policy corrections_log_select_public
on public.corrections_log
for select
to public
using (organization_id is not null);

create policy corrections_log_insert_public
on public.corrections_log
for insert
to public
with check (organization_id is not null);
