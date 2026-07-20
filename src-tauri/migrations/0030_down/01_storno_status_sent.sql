-- Reverses 0030: restore the legacy 'issued' status on storno rows that
-- are still 'sent'. Stornos are identified by references_invoice_id, which
-- is written exclusively by cancelInvoice. Stornos meanwhile marked 'paid'
-- keep that status — 0030 never touched them.
UPDATE invoices
SET status = 'issued'
WHERE status = 'sent' AND references_invoice_id IS NOT NULL;
