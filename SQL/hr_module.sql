create extension if not exists pgcrypto;

create table if not exists public.hr_employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  phone text,
  role text,
  base_salary numeric not null default 0,
  status text not null default 'active',
  start_date date,
  note text,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.hr_attendance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid,
  employee_name text not null,
  attendance_date date not null,
  status text not null default 'present',
  note text,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.hr_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid,
  employee_name text not null,
  payment_date date not null,
  payment_type text not null default 'salary',
  amount numeric not null default 0,
  note text,
  created_by uuid,
  user_name text,
  created_at timestamp with time zone not null default now()
);

create index if not exists hr_employees_org_idx
  on public.hr_employees (organization_id, status, name);

create index if not exists hr_attendance_org_date_idx
  on public.hr_attendance (organization_id, attendance_date desc);

create index if not exists hr_payments_org_date_idx
  on public.hr_payments (organization_id, payment_date desc);

alter table public.hr_employees enable row level security;
alter table public.hr_attendance enable row level security;
alter table public.hr_payments enable row level security;

drop policy if exists hr_employees_public_all on public.hr_employees;
create policy hr_employees_public_all
on public.hr_employees
for all
to public
using (true)
with check (true);

drop policy if exists hr_attendance_public_all on public.hr_attendance;
create policy hr_attendance_public_all
on public.hr_attendance
for all
to public
using (true)
with check (true);

drop policy if exists hr_payments_public_all on public.hr_payments;
create policy hr_payments_public_all
on public.hr_payments
for all
to public
using (true)
with check (true);

insert into public.role_permissions (organization_id, role_code, permission)
values
  (null, 'owner', 'page:rh'),
  (null, 'owner', 'hr:create'),
  (null, 'owner', 'hr:view'),
  (null, 'manager', 'page:rh'),
  (null, 'manager', 'hr:create'),
  (null, 'manager', 'hr:view'),
  (null, 'accountant', 'page:rh'),
  (null, 'accountant', 'hr:create'),
  (null, 'accountant', 'hr:view'),
  (null, 'readonly', 'page:rh'),
  (null, 'readonly', 'hr:view')
on conflict do nothing;
