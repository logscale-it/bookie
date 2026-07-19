-- EÜR (§ 4 Abs. 3 EStG) is computed on the Zufluss-/Abflussprinzip
-- (§ 11 EStG): revenue counts when the money actually arrives, expenses
-- when they are actually paid — not on the invoice date. Both ledgers
-- therefore carry the real payment date. Nullable; non-NULL exactly while
-- the row is in its paid status ('paid' / 'bezahlt'), maintained by the
-- status-transition helpers in src/lib/db.
--
-- The invoices immutability trigger (0021) and audit triggers (0019)
-- enumerate their columns explicitly and do not reference paid_date, so
-- both the ALTER TABLE and the backfill UPDATE below are legal on issued
-- rows. The backfill does produce one audit row per already-paid invoice
-- with an empty fields_diff — harmless, and it documents the backfill.
ALTER TABLE invoices ADD COLUMN paid_date TEXT;
ALTER TABLE incoming_invoices ADD COLUMN paid_date TEXT;

-- Backfill rows already marked paid with the best available Zufluss
-- signal: the moment the status flipped to 'paid' in the history table,
-- falling back to the invoice date.
UPDATE invoices
SET paid_date = COALESCE(
  (SELECT date(MAX(h.changed_at))
     FROM invoice_status_history h
    WHERE h.invoice_id = invoices.id AND h.to_status = 'paid'),
  issue_date)
WHERE status = 'paid';

UPDATE incoming_invoices
SET paid_date = invoice_date
WHERE status = 'bezahlt';
