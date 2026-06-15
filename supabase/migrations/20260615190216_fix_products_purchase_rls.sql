begin;

alter table public.products enable row level security;

drop policy if exists products_member_access on public.products;

create policy products_member_access
on public.products
for all
to authenticated
using ((select public.is_org_member(products.organization_id)))
with check ((select public.is_org_member(products.organization_id)));

grant select, insert, update, delete on table public.products to authenticated;
revoke insert, update, delete, truncate on table public.products from anon;

comment on policy products_member_access on public.products is
  'Active organization members can read and manage only their organization products.';

commit;
