-- Down migration for DAT-2.b storno schema changes (0021).
--
-- Reverses, in order:
--   1. Restores the immutability UPDATE trigger from 0020 (without the new
--      columns), so dropping the columns below cannot leave a trigger that
--      references nonexistent columns.
--   2. Rebuilds invoice_items WITH the original CHECK constraints, undoing
--      the relax in 0021. Rows with negative quantity / unit_price_net /
--      line_total_net would violate the restored CHECKs, but a down
--      migration is permitted to fail in that case — by that point a
--      reviewer is already in the data-loss territory and must reconcile
--      manually.
--   3. Drops the index on the new column, then drops both new columns from
--      invoices via the same CREATE / INSERT / DROP / RENAME recipe used
--      in migration 0016.

-- 1. Restore the previous immutability UPDATE trigger (column list as of 0020).
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
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

-- 2. Rebuild invoice_items with the original CHECK constraints.
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
  CONSTRAINT invoice_items_time_entry_fk FOREIGN KEY (time_entry_id) REFERENCES time_entries (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT invoice_items_quantity_check CHECK (quantity >= 0),
  CONSTRAINT invoice_items_unit_price_check CHECK (unit_price_net >= 0),
  CONSTRAINT invoice_items_line_total_check CHECK (line_total_net >= 0)
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

-- 3. Drop the index, then drop the new columns from invoices using the
--    same table-rebuild recipe as migration 0016. Column list mirrors
--    0016 exactly (DROP COLUMN cannot be used in SQLite ALTER TABLE
--    when the column is referenced by a trigger; rebuild is safest).
DROP INDEX IF EXISTS idx_invoices_references_invoice_id;

PRAGMA foreign_keys=OFF;
BEGIN;

CREATE TABLE invoices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  project_id INTEGER,
  invoice_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  issue_date TEXT NOT NULL,
  due_date TEXT,
  service_period_start TEXT,
  service_period_end TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  net_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  gross_amount REAL NOT NULL DEFAULT 0,
  issuer_name TEXT,
  issuer_tax_number TEXT,
  issuer_vat_id TEXT,
  issuer_bank_account_holder TEXT,
  issuer_bank_iban TEXT,
  issuer_bank_bic TEXT,
  issuer_bank_name TEXT,
  recipient_name TEXT,
  recipient_street TEXT,
  recipient_postal_code TEXT,
  recipient_city TEXT,
  recipient_country_code TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_date TEXT,
  due_surcharge REAL NOT NULL DEFAULT 0,
  s3_key TEXT,
  language TEXT NOT NULL DEFAULT 'de',
  legal_country_code TEXT NOT NULL DEFAULT 'DE',
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT invoices_company_fk FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT invoices_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT invoices_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT invoices_number_unique_per_company UNIQUE (company_id, invoice_number),
  CONSTRAINT invoices_service_period_check CHECK (
    service_period_start IS NULL
    OR service_period_end IS NULL
    OR service_period_start <= service_period_end
  )
);

INSERT INTO invoices_new (
  id, company_id, customer_id, project_id, invoice_number, status, issue_date,
  due_date, service_period_start, service_period_end, currency, net_amount,
  tax_amount, gross_amount, issuer_name, issuer_tax_number, issuer_vat_id,
  issuer_bank_account_holder, issuer_bank_iban, issuer_bank_bic,
  issuer_bank_name, recipient_name, recipient_street, recipient_postal_code,
  recipient_city, recipient_country_code, notes, created_at, updated_at,
  delivery_date, due_surcharge, s3_key, language, legal_country_code,
  net_cents, tax_cents, gross_cents
)
SELECT
  id, company_id, customer_id, project_id, invoice_number, status, issue_date,
  due_date, service_period_start, service_period_end, currency, net_amount,
  tax_amount, gross_amount, issuer_name, issuer_tax_number, issuer_vat_id,
  issuer_bank_account_holder, issuer_bank_iban, issuer_bank_bic,
  issuer_bank_name, recipient_name, recipient_street, recipient_postal_code,
  recipient_city, recipient_country_code, notes, created_at, updated_at,
  delivery_date, due_surcharge, s3_key, language, legal_country_code,
  net_cents, tax_cents, gross_cents
FROM invoices;

DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;

CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices (project_id);

PRAGMA foreign_key_check;

COMMIT;
PRAGMA foreign_keys=ON;
