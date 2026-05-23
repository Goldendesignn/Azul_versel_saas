alter table public.profiles
  add column if not exists role text,
  add column if not exists status text,
  add column if not exists auth_user_id uuid,
  add column if not exists last_seen_at timestamp with time zone;

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

update public.sales s
set user_name = coalesce(nullif(s.user_name, ''), p.name, p.email)
from public.profiles p
where s.organization_id = p.organization_id
  and lower(coalesce(s.user_name, '')) = ''
  and coalesce(nullif(p.role, ''), 'member') = 'owner';

update public.purchases pch
set user_name = coalesce(nullif(pch.user_name, ''), p.name, p.email)
from public.profiles p
where pch.organization_id = p.organization_id
  and lower(coalesce(pch.user_name, '')) = ''
  and coalesce(nullif(p.role, ''), 'member') = 'owner';

update public.expenses e
set user_name = coalesce(nullif(e.user_name, ''), p.name, p.email)
from public.profiles p
where e.organization_id = p.organization_id
  and lower(coalesce(e.user_name, '')) = ''
  and coalesce(nullif(p.role, ''), 'member') = 'owner';

update public.client_payments cp
set user_name = coalesce(nullif(cp.user_name, ''), p.name, p.email)
from public.profiles p
where cp.organization_id = p.organization_id
  and lower(coalesce(cp.user_name, '')) = ''
  and coalesce(nullif(p.role, ''), 'member') = 'owner';

update public.supplier_payments sp
set user_name = coalesce(nullif(sp.user_name, ''), p.name, p.email)
from public.profiles p
where sp.organization_id = p.organization_id
  and lower(coalesce(sp.user_name, '')) = ''
  and coalesce(nullif(p.role, ''), 'member') = 'owner';
