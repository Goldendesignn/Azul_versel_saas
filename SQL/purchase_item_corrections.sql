-- Correccao de compras por produto.
-- Permite corrigir uma linha de compra sem anular a compra inteira.

alter table public.purchase_items
  add column if not exists corrected_at timestamp with time zone,
  add column if not exists corrected_by uuid,
  add column if not exists corrected_by_name text,
  add column if not exists correction_reason text,
  add column if not exists correction_type text;

create index if not exists purchase_items_correction_idx
  on public.purchase_items (purchase_id, corrected_at);

alter table public.products
  add column if not exists hidden_from_pos boolean not null default false;

create index if not exists products_hidden_from_pos_idx
  on public.products (organization_id, hidden_from_pos);
