-- DAT-2.a: Reject mutations and deletes on issued invoices.
--
-- GoBD requires that once an invoice is issued (status leaves 'draft'),
-- its content is immutable. Only a documented storno/correction flow may
-- create offsetting records; the original row must not be silently rewritten.
--
-- These triggers enforce that invariant at the SQL layer:
--   * BEFORE UPDATE: if the row was issued (status <> 'draft') and ANY
--     column other than status, updated_at, s3_key changes, abort with
--     'invoice_immutable'. Status transitions (e.g. sent -> paid) and
--     bookkeeping fields (updated_at timestamp, s3_key for backup uploads)
--     remain allowed.
--   * BEFORE DELETE: if the row was issued, abort with 'invoice_immutable'.
--     Drafts may still be deleted.
--
-- The column list below enumerates every column on `invoices` as of
-- migration 0018 (see migration 0016 for the consolidated definition,
-- plus there have been no later ALTERs on this table). `IS NOT` is used
-- instead of `<>` so NULL-vs-NULL compares equal and NULL-vs-value
-- compares unequal, which is the SQLite-correct way to detect a change.

CREATE TRIGGER IF NOT EXISTS invoices_immutable_update
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
    OR NEW.net_amount                  IS NOT OLD.net_amount
    OR NEW.tax_amount                  IS NOT OLD.tax_amount
    OR NEW.gross_amount                IS NOT OLD.gross_amount
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
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

CREATE TRIGGER IF NOT EXISTS invoices_immutable_delete
BEFORE DELETE ON invoices
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;
