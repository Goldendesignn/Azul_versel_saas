-- SAF-T AO foundation. XML generation and cryptographic signing are enabled only
-- after the official AGT XSD and software-validation credentials are configured.

alter table public.products
  add column if not exists saft_product_type text not null default 'M'
    check (saft_product_type in ('M', 'P', 'A', 'S', 'T', 'B', 'O')),
  add column if not exists saft_tax_code text not null default 'NOR';

alter table public.fiscal_documents
  add column if not exists integrity_hash text,
  add column if not exists previous_integrity_hash text,
  add column if not exists signature_status text not null default 'pending'
    check (signature_status in ('pending', 'configured', 'signed'));

create table if not exists public.saft_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  export_type text not null check (export_type in ('billing', 'purchases', 'accounting', 'inventory')),
  period_from date not null,
  period_to date not null,
  status text not null default 'prepared' check (status in ('prepared', 'validated', 'downloaded', 'submitted', 'rejected')),
  schema_version text not null default 'AGT-XSD-pending',
  document_count integer not null default 0,
  validation_errors jsonb not null default '[]'::jsonb,
  checksum text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists saft_exports_org_period_idx
  on public.saft_exports (organization_id, period_to desc);

alter table public.saft_exports enable row level security;
revoke all on public.saft_exports from anon;
revoke all on public.saft_exports from authenticated;
grant select on public.saft_exports to authenticated;
drop policy if exists saft_exports_member_select on public.saft_exports;
create policy saft_exports_member_select on public.saft_exports
  for select to authenticated using (public.is_org_member(organization_id));

create or replace function public.azul_set_fiscal_document_integrity_hash()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_previous text; v_total text;
begin
  select integrity_hash into v_previous
  from public.fiscal_documents
  where organization_id = new.organization_id
    and document_type = new.document_type
    and series_code = new.series_code
  order by sequence_number desc
  limit 1;
  v_total := coalesce(new.tax_summary ->> 'grand_total', new.totals_snapshot ->> 'total', '0');
  new.previous_integrity_hash := v_previous;
  new.integrity_hash := encode(digest(concat_ws(';', new.operation_date::text, new.issued_at::text, new.document_number, v_total, coalesce(v_previous, '')), 'sha256'), 'hex');
  return new;
end;
$$;
revoke all on function public.azul_set_fiscal_document_integrity_hash() from public;
drop trigger if exists fiscal_documents_integrity_before_insert on public.fiscal_documents;
create trigger fiscal_documents_integrity_before_insert
  before insert on public.fiscal_documents
  for each row execute function public.azul_set_fiscal_document_integrity_hash();

create or replace function public.saft_billing_preflight(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_errors jsonb := '[]'::jsonb; v_documents integer := 0; v_products integer := 0;
begin
  if auth.uid() is null or not public.can_manage_fiscal_documents(p_organization_id) then raise exception 'Sem permissao para preparar SAF-T.'; end if;
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Periodo SAF-T invalido.'; end if;
  select count(*) into v_documents from public.fiscal_documents where organization_id = p_organization_id and operation_date between p_from and p_to and is_fiscal_document = true;
  select count(*) into v_products from public.products where organization_id = p_organization_id and (coalesce(trim(code), '') = '' or coalesce(trim(unit), '') = '');
  if v_products > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'PRODUCT_MASTER_DATA', 'message', 'Existem produtos sem codigo ou unidade de medida.', 'count', v_products)); end if;
  if exists (select 1 from public.fiscal_documents where organization_id = p_organization_id and operation_date between p_from and p_to and is_fiscal_document = true and (coalesce(issuer_snapshot ->> 'nif', '') = '' or coalesce(issuer_snapshot ->> 'legal_name', '') = '')) then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'ISSUER_DATA', 'message', 'Existem documentos sem NIF ou razao social do emitente.')); end if;
  if exists (select 1 from public.fiscal_documents where organization_id = p_organization_id and operation_date between p_from and p_to and is_fiscal_document = true and coalesce(integrity_hash, '') = '') then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'INTEGRITY_HASH', 'message', 'Existem documentos anteriores sem cadeia de integridade.')); end if;
  return jsonb_build_object('ready_for_xsd_validation', jsonb_array_length(v_errors) = 0, 'document_count', v_documents, 'errors', v_errors, 'schema_status', 'AGT_XSD_REQUIRED');
end;
$$;
revoke all on function public.saft_billing_preflight(uuid, date, date) from public;
grant execute on function public.saft_billing_preflight(uuid, date, date) to authenticated;

create or replace function public.prepare_saft_billing_export(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_preflight jsonb;
  v_export_id uuid;
  v_user_id uuid := auth.uid();
begin
  v_preflight := public.saft_billing_preflight(p_organization_id, p_from, p_to);

  insert into public.saft_exports (
    organization_id,
    export_type,
    period_from,
    period_to,
    status,
    document_count,
    validation_errors,
    created_by
  )
  values (
    p_organization_id,
    'billing',
    p_from,
    p_to,
    case when coalesce((v_preflight ->> 'ready_for_xsd_validation')::boolean, false)
      then 'validated' else 'prepared' end,
    coalesce((v_preflight ->> 'document_count')::integer, 0),
    coalesce(v_preflight -> 'errors', '[]'::jsonb),
    v_user_id
  )
  returning id into v_export_id;

  return v_preflight || jsonb_build_object('export_id', v_export_id);
end;
$$;

revoke all on function public.prepare_saft_billing_export(uuid, date, date) from public;
grant execute on function public.prepare_saft_billing_export(uuid, date, date) to authenticated;
