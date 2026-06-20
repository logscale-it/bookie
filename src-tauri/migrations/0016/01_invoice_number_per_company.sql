-- Scope invoice_number uniqueness to per-company, allowing multiple companies to reuse
-- the same invoice number format (e.g., both company A and B can have "2026-001").
-- SQLite does not support renaming or dropping constraints in place, so we use the
-- standard recipe: CREATE TABLE _new, INSERT SELECT, DROP, RENAME.

-- Columns in invoices table (verified through migration 0001..0015):
-- id, company_id, customer_id, project_id, invoice_number, status, issue_date, due_date,
-- service_period_start, service_period_end, currency, net_amount, tax_amount, gross_amount,
-- issuer_name, issuer_tax_number, issuer_vat_id, issuer_bank_account_holder,
-- issuer_bank_iban, issuer_bank_bic, issuer_bank_name, recipient_name, recipient_street,
-- recipient_postal_code, recipient_city, recipient_country_code, notes, created_at,
-- updated_at, delivery_date (0004), due_surcharge (0004), s3_key (0013),
-- language (0014), legal_country_code (0014),
-- net_cents (0015), tax_cents (0015), gross_cents (0015)

-- tauri-plugin-sql runs each migration inside its own transaction (no_tx=false),
-- so this migration must not open its own BEGIN/COMMIT (SQLite rejects a nested
-- transaction). `PRAGMA foreign_keys=OFF` is a no-op inside a transaction;
-- `defer_foreign_keys=ON` defers FK enforcement until the plugin commits, then
-- auto-resets.
PRAGMA defer_foreign_keys=ON;

-- Preserve child rows across the parent rebuild. `DROP TABLE invoices` performs an
-- implicit DELETE of every invoices row, which — with FKs enabled, as they are
-- inside the plugin's transaction — fires ON DELETE CASCADE on invoice_items and
-- invoice_status_history and trips the ON DELETE RESTRICT on payments (failing the
-- deferred check at COMMIT). foreign_keys cannot be turned off inside a transaction,
-- so instead we snapshot the children, clear them before the drop (nothing left to
-- cascade or restrict), then reinsert them after the rebuild. Ids are copied
-- verbatim, so every FK resolves again and the deferred check passes at COMMIT.
CREATE TEMP TABLE _invoices_rebuild_items    AS SELECT * FROM invoice_items;
CREATE TEMP TABLE _invoices_rebuild_history  AS SELECT * FROM invoice_status_history;
CREATE TEMP TABLE _invoices_rebuild_payments AS SELECT * FROM payments;
DELETE FROM payments;
DELETE FROM invoice_status_history;
DELETE FROM invoice_items;

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

INSERT INTO invoices_new SELECT * FROM invoices;

DROP TABLE invoices;

ALTER TABLE invoices_new RENAME TO invoices;

-- Restore the child rows captured above, now that invoices (with identical ids)
-- exists again, then drop the snapshots.
INSERT INTO invoice_items          SELECT * FROM _invoices_rebuild_items;
INSERT INTO invoice_status_history SELECT * FROM _invoices_rebuild_history;
INSERT INTO payments               SELECT * FROM _invoices_rebuild_payments;
DROP TABLE _invoices_rebuild_items;
DROP TABLE _invoices_rebuild_history;
DROP TABLE _invoices_rebuild_payments;

-- Recreate indexes that were on the original table
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices (project_id);

-- Verify foreign key integrity before committing
PRAGMA foreign_key_check;
