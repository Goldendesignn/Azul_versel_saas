-- Web Push complet: abonnements + trigger vers Supabase Edge Function.
-- A executer une seule fois dans Supabase SQL Editor apres avoir deploye la fonction.

create extension if not exists pgcrypto;
create extension if not exists pg_net;

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

create unique index if not exists push_subscriptions_endpoint_key
  on public.push_subscriptions (endpoint);

create index if not exists push_subscriptions_org_active_idx
  on public.push_subscriptions (organization_id, active);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_public_select on public.push_subscriptions;
drop policy if exists push_subscriptions_public_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_public_update on public.push_subscriptions;

create policy push_subscriptions_public_select
on public.push_subscriptions
for select
to public
using (true);

create policy push_subscriptions_public_insert
on public.push_subscriptions
for insert
to public
with check (true);

create policy push_subscriptions_public_update
on public.push_subscriptions
for update
to public
using (true)
with check (true);

create or replace function public.trigger_send_push_notification()
returns trigger
language plpgsql
security definer
as $$
declare
  edge_url text := current_setting('app.edge_send_push_url', true);
  edge_secret text := current_setting('app.edge_function_secret', true);
begin
  if coalesce(edge_url, '') = '' then
    return new;
  end if;

  perform net.http_post(
    url := edge_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(edge_secret, '')
    ),
    body := jsonb_build_object('notification_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

drop trigger if exists trg_send_push_notification on public.notifications;
create trigger trg_send_push_notification
after insert on public.notifications
for each row
execute function public.trigger_send_push_notification();

-- Configure ces deux valeurs APRES le deploy de la Edge Function:
-- alter database postgres set app.edge_send_push_url = 'https://TON-PROJET.supabase.co/functions/v1/send-push-notification';
-- alter database postgres set app.edge_function_secret = 'TON_SECRET_LONG_ALEATOIRE';
-- select pg_reload_conf();
