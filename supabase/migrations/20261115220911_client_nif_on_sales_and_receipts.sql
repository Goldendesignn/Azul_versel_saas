-- Customer NIF is kept as a sale snapshot so issued receipts and fiscal
-- documents always show the identifier used at the time of the transaction.
alter table public.sales
  add column if not exists client_nif text;

alter table public.sales
  drop constraint if exists sales_client_nif_length_check;

alter table public.sales
  add constraint sales_client_nif_length_check
  check (client_nif is null or char_length(btrim(client_nif)) between 1 and 20);

create index if not exists sales_org_client_name_nif_idx
  on public.sales (organization_id, client_name, created_at desc)
  where client_nif is not null;

create or replace function public.issue_sale_fiscal_document(
  p_sale_id uuid,
  p_document_type text
)
returns table (document_id uuid, document_number text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_sale public.sales%rowtype;
  v_profile public.fiscal_profiles%rowtype;
  v_series text;
  v_sequence bigint;
  v_year integer;
  v_document_id uuid;
  v_document_number text;
  v_lines jsonb;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if p_document_type not in ('invoice', 'invoice_receipt') then raise exception 'Tipo de documento invalido.'; end if;
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then raise exception 'Venda nao encontrada.'; end if;
  if not public.can_manage_fiscal_documents(v_sale.organization_id) then raise exception 'Sem permissao para emitir documento fiscal desta organizacao.'; end if;
  if exists (select 1 from public.fiscal_documents where sale_id = v_sale.id and document_type in ('invoice', 'invoice_receipt')) then raise exception 'Esta venda ja possui uma factura ou factura-recibo.'; end if;
  select * into v_profile from public.fiscal_profiles where organization_id = v_sale.organization_id;
  if not found or coalesce(trim(v_profile.legal_name), '') = '' or coalesce(trim(v_profile.nif), '') = '' then raise exception 'Complete a razao social e o NIF no perfil fiscal antes de emitir uma factura.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id', si.product_id, 'description', si.product_name, 'quantity', si.quantity, 'unit', si.unit, 'unit_price', si.unit_price, 'total', si.total, 'variation', si.variation) order by si.id), '[]'::jsonb)
  into v_lines from public.sale_items si where si.sale_id = v_sale.id;
  if jsonb_array_length(v_lines) = 0 then raise exception 'A venda nao possui linhas para facturacao.'; end if;
  v_series := case when p_document_type = 'invoice' then 'FT' else 'FR' end;
  v_year := extract(year from coalesce(v_sale.sale_date, current_date))::integer;
  insert into public.fiscal_document_series (organization_id, document_type, series_code, fiscal_year)
  values (v_sale.organization_id, p_document_type, v_series, v_year)
  on conflict (organization_id, document_type, series_code, fiscal_year) do nothing;
  update public.fiscal_document_series set next_number = next_number + 1
  where organization_id = v_sale.organization_id and document_type = p_document_type and series_code = v_series and fiscal_year = v_year and active = true
  returning next_number - 1 into v_sequence;
  if v_sequence is null then raise exception 'Serie fiscal inativa ou indisponivel.'; end if;
  v_document_number := format('%s %s/%s/%s', v_series, v_year, lpad(v_sequence::text, 6, '0'), 'AZUL');
  insert into public.fiscal_documents (organization_id, sale_id, document_type, series_code, sequence_number, document_number, operation_date, issuer_snapshot, customer_snapshot, totals_snapshot, lines_snapshot, source_snapshot, created_by, document_status, is_fiscal_document)
  values (
    v_sale.organization_id, v_sale.id, p_document_type, v_series, v_sequence, v_document_number, coalesce(v_sale.sale_date, current_date),
    jsonb_build_object('legal_name', v_profile.legal_name, 'nif', v_profile.nif, 'address', v_profile.fiscal_address, 'regime', v_profile.tax_regime, 'vat_rate', v_profile.vat_rate),
    jsonb_build_object('name', coalesce(nullif(trim(v_sale.client_name), ''), 'Consumidor final'), 'nif', nullif(trim(v_sale.client_nif), '')),
    jsonb_build_object('total', v_sale.total, 'payment_summary', v_sale.payment_summary, 'payment_lines', coalesce(v_sale.payment_lines, '[]'::jsonb)),
    v_lines, jsonb_build_object('sale_receipt_no', v_sale.receipt_no, 'sale_type', v_sale.sale_type, 'sale_id', v_sale.id), auth.uid(),
    case when p_document_type = 'invoice_receipt' then 'settled' else 'issued' end, true
  ) returning id into v_document_id;
  insert into public.fiscal_document_events (organization_id, fiscal_document_id, event_type, event_data, actor_user_id)
  values (v_sale.organization_id, v_document_id, 'issued', jsonb_build_object('sale_id', v_sale.id, 'document_type', p_document_type), auth.uid());
  return query select v_document_id, v_document_number;
end;
$$;

revoke all on function public.issue_sale_fiscal_document(uuid, text) from public;
grant execute on function public.issue_sale_fiscal_document(uuid, text) to authenticated;
