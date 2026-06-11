-- Azul Gestao V2 - compatibilidade do esquema de vendas.
-- Pode ser executado varias vezes sem apagar dados.

alter table public.sales
  add column if not exists profit numeric not null default 0;

update public.sales as sale
set profit = totals.profit
from (
  select
    item.sale_id,
    sum(
      coalesce(
        item.profit,
        (
          coalesce(item.unit_price, 0) -
          coalesce(item.purchase_price, 0)
        ) * coalesce(item.quantity, 0)
      )
    ) as profit
  from public.sale_items as item
  where item.sale_id is not null
  group by item.sale_id
) as totals
where sale.id = totals.sale_id
  and coalesce(sale.profit, 0) = 0;

notify pgrst, 'reload schema';
