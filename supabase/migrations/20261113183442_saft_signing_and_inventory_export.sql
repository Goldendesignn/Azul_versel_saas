-- SAF-T AO signing support. The RSA private key never enters this database.
-- It is read only by the protected saft-export Edge Function from project secrets.

alter table public.fiscal_documents
  add column if not exists signature_value text,
  add column if not exists signature_key_version integer,
  add column if not exists signature_payload text;
alter table public.fiscal_documents
  drop constraint if exists fiscal_documents_signature_key_version_check;
alter table public.fiscal_documents
  add constraint fiscal_documents_signature_key_version_check
  check (signature_key_version is null or signature_key_version > 0);

alter table public.fiscal_document_events
  drop constraint if exists fiscal_document_events_event_type_check;
alter table public.fiscal_document_events
  add constraint fiscal_document_events_event_type_check
  check (event_type in ('issued', 'printed', 'exported', 'credited', 'debited', 'signed'));

alter table public.saft_exports
  add column if not exists generated_at timestamptz,
  add column if not exists generated_by uuid,
  add column if not exists generated_format text;

create or replace function public.azul_prevent_fiscal_history_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'fiscal_documents' and tg_op = 'update' then
    if current_setting('azul.fiscal_signing', true) = 'on'
       and old.signature_value is null
       and new.signature_value is not null
       and new.signature_key_version is not null
       and new.signature_payload is not null
       and new.signature_status = 'signed'
       and (to_jsonb(new) - array['signature_value', 'signature_key_version', 'signature_payload', 'signature_status'])
         is not distinct from
         (to_jsonb(old) - array['signature_value', 'signature_key_version', 'signature_payload', 'signature_status'])
    then
      return new;
    end if;
  end if;

  raise exception 'Les documents fiscaux et leur journal ne peuvent pas etre modifies ou supprimes.';
end;
$$;
revoke all on function public.azul_prevent_fiscal_history_change() from public;

create or replace function public.record_saft_document_signature(
  p_document_id uuid,
  p_signature_value text,
  p_key_version integer,
  p_signed_payload text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.fiscal_documents%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Assinatura SAF-T reservada ao servico seguro.';
  end if;
  if coalesce(trim(p_signature_value), '') = ''
     or coalesce(trim(p_signed_payload), '') = ''
     or coalesce(p_key_version, 0) < 1 then
    raise exception 'Dados de assinatura SAF-T invalidos.';
  end if;

  select * into v_document
  from public.fiscal_documents
  where id = p_document_id
  for update;
  if not found then raise exception 'Documento fiscal nao encontrado.'; end if;
  if v_document.signature_value is not null then
    raise exception 'O documento fiscal ja possui uma assinatura.';
  end if;

  perform set_config('azul.fiscal_signing', 'on', true);
  update public.fiscal_documents
  set signature_value = trim(p_signature_value),
      signature_key_version = p_key_version,
      signature_payload = p_signed_payload,
      signature_status = 'signed'
  where id = p_document_id;

  insert into public.fiscal_document_events (
    organization_id,
    fiscal_document_id,
    event_type,
    event_data,
    actor_user_id
  ) values (
    v_document.organization_id,
    v_document.id,
    'signed',
    jsonb_build_object('key_version', p_key_version, 'algorithm', 'RSA-SHA1', 'source', 'saft-export-edge-function'),
    null
  );
end;
$$;
revoke all on function public.record_saft_document_signature(uuid, text, integer, text) from public;
grant execute on function public.record_saft_document_signature(uuid, text, integer, text) to service_role;
