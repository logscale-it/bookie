-- Reverses 0029. paid_date is referenced by no trigger, view, or index,
-- so a plain DROP COLUMN is legal on both tables.
ALTER TABLE invoices DROP COLUMN paid_date;
ALTER TABLE incoming_invoices DROP COLUMN paid_date;
