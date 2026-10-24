-- Down for 0033: restore the 0032 trigger (without the issuer address) first,
-- so DROP COLUMN is not blocked by a trigger that references the columns.
DROP TRIGGER IF EXISTS invoices_immutable_update;

CREATE TRIGGER invoices_immutable_update
BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft' AND (
       NEW.id                          IS NOT OLD.id
    OR NEW.company_id                  IS NOT OLD.company_id
    OR NEW.customer_id                 IS NOT OLD.customer_id
    OR NEW.project_id                  IS NOT OLD.project_id
    OR NEW.invoice_number              IS NOT OLD.invoice_number
    OR NEW.issue_date                  IS NOT OLD.issue_date
    OR NEW.due_date                    IS NOT OLD.due_date
    OR NEW.service_period_start        IS NOT OLD.service_period_start
    OR NEW.service_period_end          IS NOT OLD.service_period_end
    OR NEW.currency                    IS NOT OLD.currency
    OR NEW.issuer_name                 IS NOT OLD.issuer_name
    OR NEW.issuer_tax_number           IS NOT OLD.issuer_tax_number
    OR NEW.issuer_vat_id               IS NOT OLD.issuer_vat_id
    OR NEW.issuer_bank_account_holder  IS NOT OLD.issuer_bank_account_holder
    OR NEW.issuer_bank_iban            IS NOT OLD.issuer_bank_iban
    OR NEW.issuer_bank_bic             IS NOT OLD.issuer_bank_bic
    OR NEW.issuer_bank_name            IS NOT OLD.issuer_bank_name
    OR NEW.recipient_name              IS NOT OLD.recipient_name
    OR NEW.recipient_street            IS NOT OLD.recipient_street
    OR NEW.recipient_postal_code       IS NOT OLD.recipient_postal_code
    OR NEW.recipient_city              IS NOT OLD.recipient_city
    OR NEW.recipient_country_code      IS NOT OLD.recipient_country_code
    OR NEW.notes                       IS NOT OLD.notes
    OR NEW.created_at                  IS NOT OLD.created_at
    OR NEW.delivery_date               IS NOT OLD.delivery_date
    OR NEW.due_surcharge               IS NOT OLD.due_surcharge
    OR NEW.language                    IS NOT OLD.language
    OR NEW.legal_country_code          IS NOT OLD.legal_country_code
    OR NEW.net_cents                   IS NOT OLD.net_cents
    OR NEW.tax_cents                   IS NOT OLD.tax_cents
    OR NEW.gross_cents                 IS NOT OLD.gross_cents
    OR NEW.references_invoice_id       IS NOT OLD.references_invoice_id
    OR NEW.cancellation_reason         IS NOT OLD.cancellation_reason
    OR NEW.buyer_reference             IS NOT OLD.buyer_reference
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

ALTER TABLE invoices DROP COLUMN issuer_country_code;
ALTER TABLE invoices DROP COLUMN issuer_city;
ALTER TABLE invoices DROP COLUMN issuer_postal_code;
ALTER TABLE invoices DROP COLUMN issuer_street;
