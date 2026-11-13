-- Immutable presentation data for documents issued after this migration.
-- Existing immutable documents are deliberately not rewritten.

alter table public.fiscal_documents
  add column if not exists currency_code char(3) not null default 'AOA' check (currency_code = 'AOA'),
  add column if not exists tax_summary jsonb not null default '{"status":"pending_format_review"}'::jsonb,
  add column if not exists payment_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists issue_place text;

create or replace function public.azul_set_fiscal_document_format()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_rate numeric := 0;
  v_includes_vat boolean := true;
  v_total numeric := 0;
  v_taxable numeric := 0;
  v_vat numeric := 0;
  v_multiplier numeric := 1;
begin
  select coalesce(vat_rate, 0), coalesce(prices_include_vat, true)
  into v_rate, v_includes_vat
  from public.fiscal_profiles
  where organization_id = new.organization_id;

  v_total := coalesce((new.totals_snapshot ->> 'total')::numeric, 0);
  if new.document_type = 'credit_note' then v_multiplier := -1; end if;

  if coalesce(new.is_fiscal_document, true)
     and new.document_type in ('invoice', 'invoice_receipt', 'credit_note', 'debit_note') then
    if v_includes_vat and v_rate > 0 then
      v_taxable := v_total / (1 + v_rate / 100);
      v_vat := v_total - v_taxable;
    elsif v_rate > 0 then
      v_taxable := v_total;
      v_vat := v_total * v_rate / 100;
    else
      v_taxable := v_total;
    end if;
    new.tax_summary := jsonb_build_object(
      'status', 'calculated',
      'vat_rate', v_rate,
      'prices_include_vat', v_includes_vat,
      'taxable_amount', round(v_taxable * v_multiplier, 2),
      'vat_amount', round(v_vat * v_multiplier, 2),
      'grand_total', round((case when v_includes_vat then v_total else v_total + v_vat end) * v_multiplier, 2)
    );
  elsif new.document_type = 'receipt' then
    new.tax_summary := jsonb_build_object('status', 'payment_proof', 'grand_total', v_total);
  else
    new.tax_summary := jsonb_build_object('status', 'commercial_only', 'grand_total', v_total);
  end if;

  new.payment_snapshot := coalesce(new.totals_snapshot -> 'payment_lines', '[]'::jsonb);
  new.issue_place := coalesce(nullif(trim(new.issuer_snapshot ->> 'address'), ''), new.issue_place);
  return new;
end;
$$;

revoke all on function public.azul_set_fiscal_document_format() from public;

drop trigger if exists fiscal_documents_format_before_insert on public.fiscal_documents;
create trigger fiscal_documents_format_before_insert
  before insert on public.fiscal_documents
  for each row execute function public.azul_set_fiscal_document_format();
