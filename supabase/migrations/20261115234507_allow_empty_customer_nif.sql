-- Existing optional NIF values must be NULL, never an empty string.
update public.sales
set client_nif = null
where client_nif is not null
  and btrim(client_nif) = '';

alter table public.sales
  drop constraint if exists sales_client_nif_length_check;

alter table public.sales
  add constraint sales_client_nif_length_check
  check (client_nif is null or char_length(btrim(client_nif)) between 1 and 20);
