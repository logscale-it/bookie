-- Imported bank statement lines (CSV import, src/lib/csv/bank-csv.ts).
-- amount_cents is signed: > 0 inflow, < 0 outflow. import_key (row content +
-- occurrence in the file) makes re-imports of the same/overlapping export a no-op.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  booking_date TEXT NOT NULL,
  value_date TEXT,
  partner_name TEXT NOT NULL DEFAULT '',
  partner_iban TEXT,
  type TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  import_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, import_key)
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_company_date ON bank_transactions (company_id, booking_date);

-- Partner names of the owner's private accounts (comma-separated, e.g. "Hauptkonto"):
-- their bank lines go to Privatentnahme / Privateinlage in the DATEV export.
ALTER TABLE settings_organization ADD COLUMN datev_private_accounts TEXT NOT NULL DEFAULT '';
