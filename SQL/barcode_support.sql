-- Azul Gestao - suporte a leitura de codigo de barras
-- Executar uma vez em cada Supabase onde o POS usa barcode.

create index if not exists products_org_barcode_lookup_idx
on public.products (organization_id, lower(btrim(code)))
where code is not null and btrim(code) <> '';

