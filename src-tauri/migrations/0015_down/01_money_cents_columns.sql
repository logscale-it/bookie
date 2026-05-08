-- Drop the *_cents columns added in 0015. Requires SQLite >= 3.35 for
-- ALTER TABLE ... DROP COLUMN, which the bundled tauri-plugin-sql/sqlx
-- runtime satisfies.

ALTER TABLE incoming_invoices DROP COLUMN gross_cents;
ALTER TABLE incoming_invoices DROP COLUMN tax_cents;
ALTER TABLE incoming_invoices DROP COLUMN net_cents;

ALTER TABLE payments DROP COLUMN amount_cents;

ALTER TABLE invoice_items DROP COLUMN line_total_net_cents;
ALTER TABLE invoice_items DROP COLUMN unit_price_net_cents;

ALTER TABLE invoices DROP COLUMN gross_cents;
ALTER TABLE invoices DROP COLUMN tax_cents;
ALTER TABLE invoices DROP COLUMN net_cents;
