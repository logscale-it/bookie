-- #284: composite indexes for the per-company, per-year report queries
-- (dashboard, UStVA, EÜR, DATEV), which now filter with index-friendly
-- range predicates (`date_col >= 'YYYY-01-01' AND date_col < 'YYYY+1-01-01'`).
CREATE INDEX IF NOT EXISTS idx_invoices_company_issue_date ON invoices (company_id, issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_paid_date ON invoices (company_id, paid_date);
CREATE INDEX IF NOT EXISTS idx_incoming_invoices_company_invoice_date ON incoming_invoices (company_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_incoming_invoices_company_paid_date ON incoming_invoices (company_id, paid_date);
