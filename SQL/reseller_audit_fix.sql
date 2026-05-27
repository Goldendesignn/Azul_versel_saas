-- Correction audit du module Revendedores.
-- A executer une seule fois dans Supabase SQL Editor.

alter table public.reseller_consignments
  add column if not exists created_by uuid,
  add column if not exists user_name text;

alter table public.reseller_consignment_items
  add column if not exists created_by uuid,
  add column if not exists user_name text;

create index if not exists reseller_consignments_created_by_idx
  on public.reseller_consignments (organization_id, created_by);

create index if not exists reseller_items_created_by_idx
  on public.reseller_consignment_items (organization_id, created_by);

update public.reseller_consignments
set user_name = 'Autor antigo'
where user_name is null or trim(user_name) = '';

update public.reseller_consignment_items item
set
  created_by = coalesce(item.created_by, cons.created_by),
  user_name = coalesce(nullif(trim(item.user_name), ''), nullif(trim(cons.user_name), ''), 'Autor antigo')
from public.reseller_consignments cons
where item.consignment_id = cons.id
  and (
    item.created_by is null
    or item.user_name is null
    or trim(item.user_name) = ''
  );

notify pgrst, 'reload schema';
