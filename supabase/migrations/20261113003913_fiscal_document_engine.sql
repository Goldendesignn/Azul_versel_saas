-- Azul Gestao: noyau de documents fiscaux immuables.
-- Les ventes existantes restent intactes; ce schema ajoute une couche fiscale
-- versionnee qui sera activee dans l'interface apres configuration du profil.

create table if not exists public.fiscal_document_series (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_type text not null check (document_type in ('invoice', 'invoice_receipt', 'credit_note', 'debit_note')),
  series_code text not null check (series_code ~ '^[A-Z0-9-]{1,20}$'),
  fiscal_year integer not null check (fiscal_year between 2020 and 2100),
  next_number bigint not null default 1 check (next_number > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, document_type, series_code, fiscal_year)
);

create table if not exists public.fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  document_type text not null check (document_type in ('invoice', 'invoice_receipt', 'credit_note', 'debit_note')),
  series_code text not null,
  sequence_number bigint not null check (sequence_number > 0),
  document_number text not null,
  issued_at timestamptz not null default now(),
  operation_date date not null,
  original_document_id uuid references public.fiscal_documents(id) on delete restrict,
  reason text,
  issuer_snapshot jsonb not null,
  customer_snapshot jsonb not null default '{}'::jsonb,
  totals_snapshot jsonb not null,
  lines_snapshot jsonb not null,
  source_snapshot jsonb not null,
  software_version text not null default 'azul-saas',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, document_number),
  unique (organization_id, document_type, series_code, sequence_number),
  unique (sale_id, document_type)
);

create table if not exists public.fiscal_document_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  fiscal_document_id uuid not null references public.fiscal_documents(id) on delete restrict,
  event_type text not null check (event_type in ('issued', 'printed', 'exported', 'credited', 'debited')),
  event_data jsonb not null default '{}'::jsonb,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists fiscal_documents_org_issued_idx
  on public.fiscal_documents (organization_id, issued_at desc);
create index if not exists fiscal_documents_source_idx
  on public.fiscal_documents (sale_id) where sale_id is not null;
create index if not exists fiscal_document_events_doc_idx
  on public.fiscal_document_events (fiscal_document_id, created_at asc);

alter table public.fiscal_document_series enable row level security;
alter table public.fiscal_documents enable row level security;
alter table public.fiscal_document_events enable row level security;

revoke all on public.fiscal_document_series from anon;
revoke all on public.fiscal_documents from anon;
revoke all on public.fiscal_document_events from anon;
revoke all on public.fiscal_document_series from authenticated;
revoke all on public.fiscal_documents from authenticated;
revoke all on public.fiscal_document_events from authenticated;
grant select on public.fiscal_document_series, public.fiscal_documents, public.fiscal_document_events to authenticated;

create policy fiscal_document_series_member_select on public.fiscal_document_series
  for select to authenticated using (public.is_org_member(organization_id));
create policy fiscal_documents_member_select on public.fiscal_documents
  for select to authenticated using (public.is_org_member(organization_id));
create policy fiscal_document_events_member_select on public.fiscal_document_events
  for select to authenticated using (public.is_org_member(organization_id));

create or replace function public.azul_prevent_fiscal_history_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Les documents fiscaux et leur journal ne peuvent pas etre modifies ou supprimes.';
end;
$$;

drop trigger if exists fiscal_documents_immutable on public.fiscal_documents;
create trigger fiscal_documents_immutable
  before update or delete on public.fiscal_documents
  for each row execute function public.azul_prevent_fiscal_history_change();

drop trigger if exists fiscal_document_events_immutable on public.fiscal_document_events;
create trigger fiscal_document_events_immutable
  before update or delete on public.fiscal_document_events
  for each row execute function public.azul_prevent_fiscal_history_change();

create or replace function public.issue_fiscal_invoice(p_sale_id uuid)
returns table (document_id uuid, document_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale public.sales%rowtype;
  v_profile public.fiscal_profiles%rowtype;
  v_sequence bigint;
  v_year integer;
  v_series text := 'FT';
  v_document_id uuid;
  v_document_number text;
  v_lines jsonb;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'Venda nao encontrada.';
  end if;
  if not public.is_org_member(v_sale.organization_id) then
    raise exception 'Sem permissao para emitir documento fiscal desta organizacao.';
  end if;

  select * into v_profile from public.fiscal_profiles where organization_id = v_sale.organization_id;
  if not found or coalesce(trim(v_profile.legal_name), '') = '' or coalesce(trim(v_profile.nif), '') = '' then
    raise exception 'Complete a razao social e o NIF no perfil fiscal antes de emitir uma factura.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', si.product_id,
    'description', si.product_name,
    'quantity', si.quantity,
    'unit', si.unit,
    'unit_price', si.unit_price,
    'total', si.total,
    'variation', si.variation
  ) order by si.id), '[]'::jsonb)
  into v_lines
  from public.sale_items si
  where si.sale_id = v_sale.id;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'A venda nao possui linhas para facturacao.';
  end if;

  if exists (select 1 from public.fiscal_documents fd where fd.sale_id = v_sale.id and fd.document_type = 'invoice') then
    raise exception 'Esta venda ja possui uma factura fiscal.';
  end if;

  v_year := extract(year from coalesce(v_sale.sale_date, current_date))::integer;
  insert into public.fiscal_document_series (organization_id, document_type, series_code, fiscal_year)
  values (v_sale.organization_id, 'invoice', v_series, v_year)
  on conflict (organization_id, document_type, series_code, fiscal_year) do nothing;

  update public.fiscal_document_series
     set next_number = next_number + 1
   where organization_id = v_sale.organization_id
     and document_type = 'invoice'
     and series_code = v_series
     and fiscal_year = v_year
     and active = true
  returning next_number - 1 into v_sequence;

  if v_sequence is null then
    raise exception 'Serie fiscal inativa ou indisponivel.';
  end if;

  -- This internal format remains configurable before AGT validation.
  v_document_number := format('%s %s/%s/%s', v_series, v_year, lpad(v_sequence::text, 6, '0'), 'AZUL');

  insert into public.fiscal_documents (
    organization_id, sale_id, document_type, series_code, sequence_number, document_number,
    operation_date, issuer_snapshot, customer_snapshot, totals_snapshot, lines_snapshot,
    source_snapshot, created_by
  ) values (
    v_sale.organization_id, v_sale.id, 'invoice', v_series, v_sequence, v_document_number,
    coalesce(v_sale.sale_date, current_date),
    jsonb_build_object('legal_name', v_profile.legal_name, 'nif', v_profile.nif, 'address', v_profile.fiscal_address, 'regime', v_profile.tax_regime, 'vat_rate', v_profile.vat_rate),
    jsonb_build_object('name', coalesce(v_sale.client_name, 'Consumidor final')),
    jsonb_build_object('total', v_sale.total, 'payment_summary', v_sale.payment_summary, 'payment_lines', coalesce(v_sale.payment_lines, '[]'::jsonb)),
    v_lines,
    jsonb_build_object('sale_receipt_no', v_sale.receipt_no, 'sale_type', v_sale.sale_type, 'sale_id', v_sale.id),
    auth.uid()
  ) returning id into v_document_id;

  insert into public.fiscal_document_events (organization_id, fiscal_document_id, event_type, event_data, actor_user_id)
  values (v_sale.organization_id, v_document_id, 'issued', jsonb_build_object('sale_id', v_sale.id), auth.uid());

  return query select v_document_id, v_document_number;
end;
$$;

revoke all on function public.issue_fiscal_invoice(uuid) from public;
grant execute on function public.issue_fiscal_invoice(uuid) to authenticated;

create or replace function public.issue_fiscal_credit_note(
  p_original_document_id uuid,
  p_reason text
)
returns table (document_id uuid, document_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original public.fiscal_documents%rowtype;
  v_sequence bigint;
  v_year integer;
  v_series text := 'NC';
  v_document_id uuid;
  v_document_number text;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indique o motivo da nota de credito.';
  end if;

  select * into v_original
  from public.fiscal_documents
  where id = p_original_document_id;

  if not found or v_original.document_type not in ('invoice', 'invoice_receipt') then
    raise exception 'Documento fiscal de origem invalido.';
  end if;

  if not public.is_org_member(v_original.organization_id) then
    raise exception 'Sem permissao para corrigir este documento fiscal.';
  end if;

  if exists (
    select 1
    from public.fiscal_documents fd
    where fd.original_document_id = v_original.id
      and fd.document_type = 'credit_note'
  ) then
    raise exception 'Este documento ja possui uma nota de credito.';
  end if;

  v_year := extract(year from current_date)::integer;
  insert into public.fiscal_document_series (organization_id, document_type, series_code, fiscal_year)
  values (v_original.organization_id, 'credit_note', v_series, v_year)
  on conflict (organization_id, document_type, series_code, fiscal_year) do nothing;

  update public.fiscal_document_series
     set next_number = next_number + 1
   where organization_id = v_original.organization_id
     and document_type = 'credit_note'
     and series_code = v_series
     and fiscal_year = v_year
     and active = true
  returning next_number - 1 into v_sequence;

  if v_sequence is null then
    raise exception 'Serie fiscal inativa ou indisponivel.';
  end if;

  v_document_number := format('%s %s/%s/%s', v_series, v_year, lpad(v_sequence::text, 6, '0'), 'AZUL');

  insert into public.fiscal_documents (
    organization_id, sale_id, document_type, series_code, sequence_number, document_number,
    operation_date, original_document_id, reason, issuer_snapshot, customer_snapshot,
    totals_snapshot, lines_snapshot, source_snapshot, created_by
  ) values (
    v_original.organization_id, v_original.sale_id, 'credit_note', v_series, v_sequence, v_document_number,
    current_date, v_original.id, trim(p_reason), v_original.issuer_snapshot, v_original.customer_snapshot,
    v_original.totals_snapshot, v_original.lines_snapshot,
    jsonb_build_object('original_document_id', v_original.id, 'original_document_number', v_original.document_number),
    auth.uid()
  ) returning id into v_document_id;

  insert into public.fiscal_document_events (organization_id, fiscal_document_id, event_type, event_data, actor_user_id)
  values (
    v_original.organization_id,
    v_document_id,
    'credited',
    jsonb_build_object('original_document_id', v_original.id, 'reason', trim(p_reason)),
    auth.uid()
  );

  return query select v_document_id, v_document_number;
end;
$$;

revoke all on function public.issue_fiscal_credit_note(uuid, text) from public;
grant execute on function public.issue_fiscal_credit_note(uuid, text) to authenticated;
