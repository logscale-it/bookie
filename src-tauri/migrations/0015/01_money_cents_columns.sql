-- Add INTEGER cents columns alongside every REAL money column and backfill
-- them from the existing values via ROUND(value * 100). This is the first
-- step of moving money handling from REAL to INTEGER (see DAT-1.a, #51).
-- Application read/write paths are intentionally NOT modified here; that
-- repointing is tracked in DAT-1.b/c/d.

-- invoices: net_amount / tax_amount / gross_amount -> *_cents
ALTER TABLE invoices ADD COLUMN net_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN gross_cents INTEGER NOT NULL DEFAULT 0;

UPDATE invoices SET net_cents = CAST(ROUND(net_amount * 100) AS INTEGER);
UPDATE invoices SET tax_cents = CAST(ROUND(tax_amount * 100) AS INTEGER);
UPDATE invoices SET gross_cents = CAST(ROUND(gross_amount * 100) AS INTEGER);

-- invoice_items: unit_price_net / line_total_net -> *_cents
ALTER TABLE invoice_items ADD COLUMN unit_price_net_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN line_total_net_cents INTEGER NOT NULL DEFAULT 0;

UPDATE invoice_items SET unit_price_net_cents = CAST(ROUND(unit_price_net * 100) AS INTEGER);
UPDATE invoice_items SET line_total_net_cents = CAST(ROUND(line_total_net * 100) AS INTEGER);

-- payments: amount -> amount_cents
ALTER TABLE payments ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0;

UPDATE payments SET amount_cents = CAST(ROUND(amount * 100) AS INTEGER);

-- incoming_invoices: net_amount / tax_amount / gross_amount -> *_cents
ALTER TABLE incoming_invoices ADD COLUMN net_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incoming_invoices ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incoming_invoices ADD COLUMN gross_cents INTEGER NOT NULL DEFAULT 0;

UPDATE incoming_invoices SET net_cents = CAST(ROUND(net_amount * 100) AS INTEGER);
UPDATE incoming_invoices SET tax_cents = CAST(ROUND(tax_amount * 100) AS INTEGER);
UPDATE incoming_invoices SET gross_cents = CAST(ROUND(gross_amount * 100) AS INTEGER);
