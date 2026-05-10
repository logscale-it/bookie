-- DAT-2.b: Storno (cancellation) support on invoices.
--
-- This migration prepares the schema so that `cancelInvoice(id, reason)` in
-- src/lib/db/invoices.ts can write a storno (reversing) entry that mirrors
-- an issued invoice with negated amounts and a reference to the original.
--
-- Three changes:
--   1. Add `references_invoice_id` to `invoices` so a storno row can point
--      back at the invoice it cancels. Plain INTEGER (no SQL-level FK):
--      SQLite ALTER TABLE ADD COLUMN cannot declare a self-referential
--      FOREIGN KEY without a full table rebuild; the application layer is
--      responsible for ensuring the referenced invoice exists.
--   2. Add `cancellation_reason` to `invoices` so the user-supplied reason
--      from cancelInvoice() is persisted alongside the storno row (rather
--      than overloading `notes`, which is freely user-editable on drafts).
--   3. Replace the `invoice_items` CHECK constraints that require quantity,
--      unit_price_net, and line_total_net to be >= 0 with versions that
--      allow negative values. Storno line items are mirrors with negated
--      quantity (or line totals) — without this the storno transaction
--      would fail at the SQL layer.
--
-- The DAT-2.a immutability trigger on invoices (migration 0020) is also
-- updated below so that on already-issued rows the new
-- `references_invoice_id` and `cancellation_reason` columns are protected
-- from modification too — defense-in-depth, since the storno row itself is
-- inserted with status='issued' and must not be silently rewritten later.
--
-- Audit triggers (migration 0019) are intentionally NOT updated here.
-- Changes to the new columns simply will not appear in invoice_audit; this
-- is a known follow-up and is acceptable because cancelInvoice() always
-- writes both columns at INSERT time (which the audit insert trigger
-- already captures into fields_diff via NEW.* of every column it knows
-- about — the storno's reason is therefore reconstructible from the new
-- row itself).

-- 1. New columns on invoices.
ALTER TABLE invoices ADD COLUMN references_invoice_id INTEGER;
ALTER TABLE invoices ADD COLUMN cancellation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_references_invoice_id
  ON invoices (references_invoice_id);

-- 2. Rebuild invoice_items to relax the >= 0 CHECK constraints.
--    SQLite cannot drop a CHECK constraint in place, so we use the standard
--    CREATE _new / INSERT SELECT / DROP / RENAME recipe. The audit triggers
--    on invoice_items (migration 0019) reference the table by name, so they
--    keep working after the RENAME without recreation.
PRAGMA foreign_keys=OFF;
BEGIN;

CREATE TABLE invoice_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  project_id INTEGER,
  time_entry_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price_net REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  line_total_net REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unit_price_net_cents INTEGER NOT NULL DEFAULT 0,
  line_total_net_cents INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT invoice_items_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT invoice_items_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT invoice_items_time_entry_fk FOREIGN KEY (time_entry_id) REFERENCES time_entries (id) ON DELETE SET NULL ON UPDATE CASCADE
  -- Intentionally no CHECK (quantity >= 0 / unit_price_net >= 0 /
  -- line_total_net >= 0): storno mirrors negate these values.
);

INSERT INTO invoice_items_new (
  id, invoice_id, project_id, time_entry_id, position, description, quantity,
  unit, unit_price_net, tax_rate, line_total_net, created_at, updated_at,
  unit_price_net_cents, line_total_net_cents
)
SELECT
  id, invoice_id, project_id, time_entry_id, position, description, quantity,
  unit, unit_price_net, tax_rate, line_total_net, created_at, updated_at,
  unit_price_net_cents, line_total_net_cents
FROM invoice_items;

DROP TABLE invoice_items;
ALTER TABLE invoice_items_new RENAME TO invoice_items;

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_project_id ON invoice_items (project_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_time_entry_id ON invoice_items (time_entry_id);

PRAGMA foreign_key_check;

COMMIT;
PRAGMA foreign_keys=ON;

-- 3. Replace the immutability UPDATE trigger so the new columns are also
--    protected on already-issued rows. The DELETE trigger from 0020 is
--    column-agnostic (only checks OLD.status) and remains correct unchanged.
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
    OR NEW.references_invoice_id       IS NOT OLD.references_invoice_id
    OR NEW.cancellation_reason         IS NOT OLD.cancellation_reason
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;
