-- Module Logistica
-- Execute este ficheiro no SQL Editor do Supabase para ativar entregas.

create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  delivery_number text not null unique,
  source_type text not null default 'manual',
  source_id uuid,
  customer_name text not null,
  customer_phone text,
  customer_address text not null,
  description text,
  amount numeric not null default 0,
  delivery_fee numeric not null default 0,
  scheduled_for timestamp with time zone,
  reminder_before_minutes integer not null default 60,
  reminder_sent_at timestamp with time zone,
  driver_name text,
  status text not null default 'pending',
  priority text not null default 'normal',
  note text,
  delivered_at timestamp with time zone,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.deliveries add column if not exists organization_id uuid;
alter table public.deliveries add column if not exists delivery_number text;
alter table public.deliveries add column if not exists source_type text default 'manual';
alter table public.deliveries add column if not exists source_id uuid;
alter table public.deliveries add column if not exists customer_name text;
alter table public.deliveries add column if not exists customer_phone text;
alter table public.deliveries add column if not exists customer_address text;
alter table public.deliveries add column if not exists description text;
alter table public.deliveries add column if not exists amount numeric not null default 0;
alter table public.deliveries add column if not exists delivery_fee numeric not null default 0;
alter table public.deliveries add column if not exists scheduled_for timestamp with time zone;
alter table public.deliveries add column if not exists reminder_before_minutes integer not null default 60;
alter table public.deliveries add column if not exists reminder_sent_at timestamp with time zone;
alter table public.deliveries add column if not exists driver_name text;
alter table public.deliveries add column if not exists status text not null default 'pending';
alter table public.deliveries add column if not exists priority text not null default 'normal';
alter table public.deliveries add column if not exists note text;
alter table public.deliveries add column if not exists delivered_at timestamp with time zone;
alter table public.deliveries add column if not exists created_by uuid;
alter table public.deliveries add column if not exists user_name text;
alter table public.deliveries add column if not exists created_at timestamp with time zone not null default now();
alter table public.deliveries add column if not exists updated_at timestamp with time zone not null default now();

update public.deliveries
set delivery_number = 'ENT-' || to_char(coalesce(created_at, now()), 'YYMMDD-HH24MISS') || '-' || upper(substr(id::text, 1, 4))
where delivery_number is null;

update public.deliveries set source_type = 'manual' where source_type is null;
update public.deliveries set status = 'pending' where status is null;
update public.deliveries set priority = 'normal' where priority is null;
update public.deliveries set amount = 0 where amount is null;
update public.deliveries set delivery_fee = 0 where delivery_fee is null;
update public.deliveries set reminder_before_minutes = 60 where reminder_before_minutes is null;

alter table public.deliveries alter column organization_id set not null;
alter table public.deliveries alter column delivery_number set not null;
alter table public.deliveries alter column source_type set not null;
alter table public.deliveries alter column customer_name set not null;
alter table public.deliveries alter column customer_address set not null;
alter table public.deliveries alter column amount set not null;
alter table public.deliveries alter column delivery_fee set not null;
alter table public.deliveries alter column reminder_before_minutes set not null;
alter table public.deliveries alter column status set not null;
alter table public.deliveries alter column priority set not null;

alter table public.deliveries drop constraint if exists deliveries_source_type_check;
alter table public.deliveries add constraint deliveries_source_type_check
  check (source_type in ('manual', 'online_order', 'sale', 'transfer'));

alter table public.deliveries drop constraint if exists deliveries_status_check;
alter table public.deliveries add constraint deliveries_status_check
  check (status in ('pending', 'scheduled', 'ready', 'in_route', 'delivered', 'failed', 'canceled'));

alter table public.deliveries drop constraint if exists deliveries_priority_check;
alter table public.deliveries add constraint deliveries_priority_check
  check (priority in ('normal', 'urgent'));

create unique index if not exists deliveries_delivery_number_key
  on public.deliveries (delivery_number);

create index if not exists idx_deliveries_org_created
  on public.deliveries (organization_id, created_at desc);

create index if not exists idx_deliveries_org_status
  on public.deliveries (organization_id, status);

create index if not exists idx_deliveries_org_schedule
  on public.deliveries (organization_id, scheduled_for)
  where scheduled_for is not null;

create index if not exists idx_deliveries_org_source
  on public.deliveries (organization_id, source_type, source_id);

create or replace function public.touch_deliveries_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_deliveries_updated_at on public.deliveries;
create trigger trg_touch_deliveries_updated_at
before update on public.deliveries
for each row
execute function public.touch_deliveries_updated_at();

alter table public.deliveries enable row level security;

grant select, insert, update on public.deliveries to anon, authenticated;

drop policy if exists deliveries_all_app on public.deliveries;
create policy deliveries_all_app
on public.deliveries
for all
to public
using (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id')
)
with check (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id')
);
