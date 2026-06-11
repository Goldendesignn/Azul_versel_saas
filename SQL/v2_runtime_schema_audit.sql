-- Azul Gestao V2 - auditoria das colunas usadas nas operacoes principais.
-- Resultado esperado: nenhuma linha.

with expected(table_name, column_name) as (
  values
    ('sales','organization_id'), ('sales','receipt_no'),
    ('sales','client_name'), ('sales','sale_date'), ('sales','sale_type'),
    ('sales','total'), ('sales','profit'), ('sales','payment_summary'),
    ('sales','payment_lines'), ('sales','created_by'), ('sales','user_name'),

    ('sale_items','sale_id'), ('sale_items','product_id'),
    ('sale_items','product_name'), ('sale_items','quantity'),
    ('sale_items','unit_price'), ('sale_items','total'),
    ('sale_items','purchase_price'), ('sale_items','profit'),
    ('sale_items','variation'), ('sale_items','variations'),

    ('products','organization_id'), ('products','name'),
    ('products','category'), ('products','supplier'),
    ('products','purchase_price'), ('products','sale_price'),
    ('products','stock_warehouse'), ('products','stock_shop'),
    ('products','min_stock'), ('products','code'),
    ('products','variation'), ('products','variations'), ('products','photo'),

    ('purchases','organization_id'), ('purchases','supplier'),
    ('purchases','total'), ('purchases','paid_amount'),
    ('purchases','remaining_amount'), ('purchases','is_credit'),
    ('purchases','created_by'), ('purchases','user_name'),

    ('purchase_items','purchase_id'), ('purchase_items','product_id'),
    ('purchase_items','product_name'), ('purchase_items','quantity'),
    ('purchase_items','purchase_price'), ('purchase_items','sale_price'),
    ('purchase_items','category'), ('purchase_items','supplier'),
    ('purchase_items','code'), ('purchase_items','variation'),
    ('purchase_items','variations'), ('purchase_items','photo'),

    ('expenses','organization_id'), ('expenses','expense_date'),
    ('expenses','category'), ('expenses','description'), ('expenses','amount'),
    ('expenses','created_by'), ('expenses','user_name'),

    ('client_payments','organization_id'), ('client_payments','client_name'),
    ('client_payments','amount'), ('client_payments','note'),
    ('client_payments','payment_date'), ('client_payments','created_by'),
    ('client_payments','user_name'),

    ('supplier_payments','organization_id'), ('supplier_payments','supplier'),
    ('supplier_payments','amount'), ('supplier_payments','note'),
    ('supplier_payments','payment_date'), ('supplier_payments','created_by'),
    ('supplier_payments','user_name'),

    ('client_debts','organization_id'), ('client_debts','sale_id'),
    ('client_debts','client_name'), ('client_debts','total_amount'),
    ('client_debts','paid_amount'), ('client_debts','remaining_amount'),
    ('client_debts','status'), ('client_debts','debt_date'),

    ('accounting_entries','organization_id'), ('accounting_entries','entry_date'),
    ('accounting_entries','source_type'), ('accounting_entries','source_id'),
    ('accounting_entries','description'), ('accounting_entries','created_by'),
    ('accounting_entries','user_name'),

    ('accounting_lines','entry_id'), ('accounting_lines','organization_id'),
    ('accounting_lines','account_code'), ('accounting_lines','account_name'),
    ('accounting_lines','debit'), ('accounting_lines','credit')
)
select expected.table_name, expected.column_name
from expected
left join information_schema.columns as existing
  on existing.table_schema = 'public'
 and existing.table_name = expected.table_name
 and existing.column_name = expected.column_name
where existing.column_name is null
order by expected.table_name, expected.column_name;
