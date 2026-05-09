-- Enforce GoBD immutability of issued invoices at the SQL layer (DAT-2.a, #57).
-- Once an invoice's status is anything other than 'draft', only status,
-- updated_at, and s3_key may change. Any other field change, or a DELETE,
-- raises 'invoice_immutable'. Draft invoices remain freely mutable.
--
-- The protected column list mirrors the invoices schema as rebuilt in
-- migration 0016 (CREATE TABLE invoices_new), minus {status, updated_at,
-- s3_key}. IS NOT is used (rather than <>) so NULL-to-NULL comparisons do
-- not spuriously fire.

CREATE TRIGGER invoices_no_update_when_issued
BEFORE UPDATE ON invoices
FOR EACH ROW
WHEN OLD.status <> 'draft'
  AND (
       OLD.id                         IS NOT NEW.id
    OR OLD.company_id                 IS NOT NEW.company_id
    OR OLD.customer_id                IS NOT NEW.customer_id
    OR OLD.project_id                 IS NOT NEW.project_id
    OR OLD.invoice_number             IS NOT NEW.invoice_number
    OR OLD.issue_date                 IS NOT NEW.issue_date
    OR OLD.due_date                   IS NOT NEW.due_date
    OR OLD.service_period_start       IS NOT NEW.service_period_start
    OR OLD.service_period_end         IS NOT NEW.service_period_end
    OR OLD.currency                   IS NOT NEW.currency
    OR OLD.net_amount                 IS NOT NEW.net_amount
    OR OLD.tax_amount                 IS NOT NEW.tax_amount
    OR OLD.gross_amount               IS NOT NEW.gross_amount
    OR OLD.issuer_name                IS NOT NEW.issuer_name
    OR OLD.issuer_tax_number          IS NOT NEW.issuer_tax_number
    OR OLD.issuer_vat_id              IS NOT NEW.issuer_vat_id
    OR OLD.issuer_bank_account_holder IS NOT NEW.issuer_bank_account_holder
    OR OLD.issuer_bank_iban           IS NOT NEW.issuer_bank_iban
    OR OLD.issuer_bank_bic            IS NOT NEW.issuer_bank_bic
    OR OLD.issuer_bank_name           IS NOT NEW.issuer_bank_name
    OR OLD.recipient_name             IS NOT NEW.recipient_name
    OR OLD.recipient_street           IS NOT NEW.recipient_street
    OR OLD.recipient_postal_code      IS NOT NEW.recipient_postal_code
    OR OLD.recipient_city             IS NOT NEW.recipient_city
    OR OLD.recipient_country_code     IS NOT NEW.recipient_country_code
    OR OLD.notes                      IS NOT NEW.notes
    OR OLD.created_at                 IS NOT NEW.created_at
    OR OLD.delivery_date              IS NOT NEW.delivery_date
    OR OLD.due_surcharge              IS NOT NEW.due_surcharge
    OR OLD.language                   IS NOT NEW.language
    OR OLD.legal_country_code         IS NOT NEW.legal_country_code
    OR OLD.net_cents                  IS NOT NEW.net_cents
    OR OLD.tax_cents                  IS NOT NEW.tax_cents
    OR OLD.gross_cents                IS NOT NEW.gross_cents
  )
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

CREATE TRIGGER invoices_no_delete_when_issued
BEFORE DELETE ON invoices
FOR EACH ROW
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;
