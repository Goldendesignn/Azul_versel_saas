create extension if not exists pgcrypto;

create table if not exists public.pos_scan_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  session_token text not null default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'active',
  device_name text,
  created_by uuid,
  expires_at timestamp with time zone not null default (now() + interval '15 minutes'),
  created_at timestamp with time zone not null default now(),
  last_seen_at timestamp with time zone not null default now()
);

create table if not exists public.pos_scan_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  session_id uuid not null references public.pos_scan_sessions(id) on delete cascade,
  session_token text not null,
  barcode text not null,
  device_name text,
  status text not null default 'pending',
  product_name text,
  error_message text,
  created_at timestamp with time zone not null default now(),
  processed_at timestamp with time zone
);

create index if not exists idx_pos_scan_sessions_org_status
  on public.pos_scan_sessions (organization_id, status, expires_at desc);

create index if not exists idx_pos_scan_events_session_created
  on public.pos_scan_events (session_id, created_at desc);

alter table public.pos_scan_sessions enable row level security;
alter table public.pos_scan_events enable row level security;

grant select, insert, update on public.pos_scan_sessions to anon, authenticated;
grant select, insert, update on public.pos_scan_events to anon, authenticated;

create or replace function public.set_pos_scan_event_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  select s.organization_id
    into v_organization_id
  from public.pos_scan_sessions s
  where s.id = new.session_id
    and s.session_token = new.session_token
    and s.status = 'active'
    and s.expires_at > now()
  limit 1;

  if v_organization_id is null then
    raise exception 'INVALID_SCAN_SESSION';
  end if;

  new.organization_id = v_organization_id;
  new.created_at = coalesce(new.created_at, now());
  return new;
end;
$$;

drop trigger if exists trg_pos_scan_event_org on public.pos_scan_events;
create trigger trg_pos_scan_event_org
before insert on public.pos_scan_events
for each row
execute function public.set_pos_scan_event_org();

create or replace function public.validate_pos_scan_session(
  p_session_id uuid,
  p_session_token text
)
returns table(ok boolean, message text, expires_at timestamp with time zone)
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.pos_scan_sessions s
    where s.id = p_session_id
      and s.session_token = p_session_token
      and s.status = 'active'
      and s.expires_at > now()
  ) then
    update public.pos_scan_sessions
      set last_seen_at = now()
    where id = p_session_id
      and session_token = p_session_token;

    return query
      select true, 'Sessao pronta'::text, s.expires_at
      from public.pos_scan_sessions s
      where s.id = p_session_id
        and s.session_token = p_session_token
      limit 1;
  else
    return query select false, 'Sessao expirada ou invalida'::text, null::timestamp with time zone;
  end if;
end;
$$;

grant execute on function public.validate_pos_scan_session(uuid, text) to anon, authenticated;

drop policy if exists pos_scan_sessions_select_by_org on public.pos_scan_sessions;
create policy pos_scan_sessions_select_by_org
on public.pos_scan_sessions
for select
to public
using (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
);

drop policy if exists pos_scan_sessions_insert_by_org on public.pos_scan_sessions;
create policy pos_scan_sessions_insert_by_org
on public.pos_scan_sessions
for insert
to public
with check (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
);

drop policy if exists pos_scan_sessions_update_by_org on public.pos_scan_sessions;
create policy pos_scan_sessions_update_by_org
on public.pos_scan_sessions
for update
to public
using (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
)
with check (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
);

drop policy if exists pos_scan_events_select_by_org on public.pos_scan_events;
create policy pos_scan_events_select_by_org
on public.pos_scan_events
for select
to public
using (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
);

drop policy if exists pos_scan_events_update_by_org on public.pos_scan_events;
create policy pos_scan_events_update_by_org
on public.pos_scan_events
for update
to public
using (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
)
with check (
  organization_id::text = ((current_setting('request.headers'::text, true))::jsonb ->> 'x-organization-id'::text)
);

drop policy if exists pos_scan_events_insert_by_valid_session on public.pos_scan_events;
create policy pos_scan_events_insert_by_valid_session
on public.pos_scan_events
for insert
to public
with check (
  exists (
    select 1
    from public.pos_scan_sessions s
    where s.id = pos_scan_events.session_id
      and s.session_token = pos_scan_events.session_token
      and s.organization_id = pos_scan_events.organization_id
      and s.status = 'active'
      and s.expires_at > now()
  )
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.pos_scan_events;
    exception
      when duplicate_object then null;
    end;
  end if;
end;
$$;
