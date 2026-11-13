-- Additional commercial and fiscal document types. Series abbreviations remain
-- configurable until the definitive AGT/SMF specification is supplied.

alter table public.fiscal_document_series
  drop constraint if exists fiscal_document_series_document_type_check;
alter table public.fiscal_document_series
  add constraint fiscal_document_series_document_type_check
  check (document_type in ('invoice', 'invoice_receipt', 'receipt', 'proforma', 'credit_note', 'debit_note'));

alter table public.fiscal_documents
  drop constraint if exists fiscal_documents_document_type_check;
alter table public.fiscal_documents
  add constraint fiscal_documents_document_type_check
  check (document_type in ('invoice', 'invoice_receipt', 'receipt', 'proforma', 'credit_note', 'debit_note'));

alter table public.fiscal_documents
  add column if not exists document_status text not null default 'issued'
    check (document_status in ('issued', 'settled', 'credited')),
  add column if not exists is_fiscal_document boolean not null default true;

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
    jsonb_build_object('name', coalesce(v_sale.client_name, 'Consumidor final')),
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

create or replace function public.issue_fiscal_invoice(p_sale_id uuid)
returns table (document_id uuid, document_number text)
language sql security definer
set search_path = public, pg_temp
as $$
  select * from public.issue_sale_fiscal_document(p_sale_id, 'invoice');
$$;
revoke all on function public.issue_fiscal_invoice(uuid) from public;
grant execute on function public.issue_fiscal_invoice(uuid) to authenticated;

create or replace function public.issue_fiscal_receipt(p_original_document_id uuid)
returns table (document_id uuid, document_number text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_original public.fiscal_documents%rowtype; v_sequence bigint; v_year integer; v_document_id uuid; v_document_number text;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  select * into v_original from public.fiscal_documents where id = p_original_document_id;
  if not found or v_original.document_type <> 'invoice' then raise exception 'Seleccione uma factura valida para emitir o recibo.'; end if;
  if not public.can_manage_fiscal_documents(v_original.organization_id) then raise exception 'Sem permissao para emitir recibo.'; end if;
  if exists (select 1 from public.fiscal_documents where original_document_id = v_original.id and document_type = 'receipt') then raise exception 'Esta factura ja possui um recibo.'; end if;
  v_year := extract(year from current_date)::integer;
  insert into public.fiscal_document_series (organization_id, document_type, series_code, fiscal_year) values (v_original.organization_id, 'receipt', 'RC', v_year) on conflict do nothing;
  update public.fiscal_document_series set next_number = next_number + 1 where organization_id = v_original.organization_id and document_type = 'receipt' and series_code = 'RC' and fiscal_year = v_year and active = true returning next_number - 1 into v_sequence;
  if v_sequence is null then raise exception 'Serie de recibos inativa ou indisponivel.'; end if;
  v_document_number := format('RC %s/%s/%s', v_year, lpad(v_sequence::text, 6, '0'), 'AZUL');
  insert into public.fiscal_documents (organization_id, sale_id, document_type, series_code, sequence_number, document_number, operation_date, original_document_id, issuer_snapshot, customer_snapshot, totals_snapshot, lines_snapshot, source_snapshot, created_by, document_status, is_fiscal_document)
  values (v_original.organization_id, v_original.sale_id, 'receipt', 'RC', v_sequence, v_document_number, current_date, v_original.id, v_original.issuer_snapshot, v_original.customer_snapshot, v_original.totals_snapshot, v_original.lines_snapshot, jsonb_build_object('original_document_id', v_original.id, 'original_document_number', v_original.document_number), auth.uid(), 'settled', false)
  returning id into v_document_id;
  insert into public.fiscal_document_events (organization_id, fiscal_document_id, event_type, event_data, actor_user_id) values (v_original.organization_id, v_document_id, 'issued', jsonb_build_object('original_document_id', v_original.id, 'document_type', 'receipt'), auth.uid());
  return query select v_document_id, v_document_number;
end;
$$;
revoke all on function public.issue_fiscal_receipt(uuid) from public;
grant execute on function public.issue_fiscal_receipt(uuid) to authenticated;

create or replace function public.issue_proforma(p_organization_id uuid, p_customer_name text, p_customer_nif text, p_lines jsonb, p_note text default null)
returns table (document_id uuid, document_number text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_org uuid; v_profile public.fiscal_profiles%rowtype; v_sequence bigint; v_year integer; v_document_id uuid; v_document_number text; v_lines jsonb; v_total numeric;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;
  v_org := p_organization_id;
  if v_org is null or not public.can_manage_fiscal_documents(v_org) then raise exception 'Sem permissao para criar proforma.'; end if;
  if coalesce(trim(p_customer_name), '') = '' then raise exception 'Indique o nome do cliente.'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Adicione pelo menos uma linha na proforma.'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) item where coalesce(trim(item->>'description'), '') = '' or coalesce(item->>'quantity', '') !~ '^[0-9]+([.][0-9]+)?$' or coalesce(item->>'unit_price', '') !~ '^[0-9]+([.][0-9]+)?$') then raise exception 'Confirme descricao, quantidade e preco em cada linha.'; end if;
  select * into v_profile from public.fiscal_profiles where organization_id = v_org;
  if not found or coalesce(trim(v_profile.legal_name), '') = '' or coalesce(trim(v_profile.nif), '') = '' then raise exception 'Complete a razao social e o NIF no perfil fiscal antes de criar uma proforma.'; end if;
  select jsonb_agg(jsonb_build_object('description', trim(item->>'description'), 'quantity', (item->>'quantity')::numeric, 'unit', coalesce(nullif(trim(item->>'unit'), ''), 'un'), 'unit_price', (item->>'unit_price')::numeric, 'total', ((item->>'quantity')::numeric * (item->>'unit_price')::numeric))) into v_lines from jsonb_array_elements(p_lines) item;
  select coalesce(sum((item->>'quantity')::numeric * (item->>'unit_price')::numeric), 0) into v_total from jsonb_array_elements(p_lines) item;
  v_year := extract(year from current_date)::integer;
  insert into public.fiscal_document_series (organization_id, document_type, series_code, fiscal_year) values (v_org, 'proforma', 'PP', v_year) on conflict do nothing;
  update public.fiscal_document_series set next_number = next_number + 1 where organization_id = v_org and document_type = 'proforma' and series_code = 'PP' and fiscal_year = v_year and active = true returning next_number - 1 into v_sequence;
  if v_sequence is null then raise exception 'Serie de proformas inativa ou indisponivel.'; end if;
  v_document_number := format('PP %s/%s/%s', v_year, lpad(v_sequence::text, 6, '0'), 'AZUL');
  insert into public.fiscal_documents (organization_id, document_type, series_code, sequence_number, document_number, operation_date, reason, issuer_snapshot, customer_snapshot, totals_snapshot, lines_snapshot, source_snapshot, created_by, document_status, is_fiscal_document)
  values (v_org, 'proforma', 'PP', v_sequence, v_document_number, current_date, nullif(trim(p_note), ''), jsonb_build_object('legal_name', v_profile.legal_name, 'nif', v_profile.nif, 'address', v_profile.fiscal_address), jsonb_build_object('name', trim(p_customer_name), 'nif', nullif(trim(p_customer_nif), '')), jsonb_build_object('total', v_total), v_lines, jsonb_build_object('commercial_document', true, 'notice', 'NAO E DOCUMENTO FISCAL'), auth.uid(), 'issued', false) returning id into v_document_id;
  insert into public.fiscal_document_events (organization_id, fiscal_document_id, event_type, event_data, actor_user_id) values (v_org, v_document_id, 'issued', jsonb_build_object('document_type', 'proforma'), auth.uid());
  return query select v_document_id, v_document_number;
end;
$$;
revoke all on function public.issue_proforma(uuid, text, text, jsonb, text) from public;
grant execute on function public.issue_proforma(uuid, text, text, jsonb, text) to authenticated;
