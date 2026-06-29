-- Recurring invoices & costs. One row per schedule. The `payload` column is a
-- JSON snapshot of the create-arguments for the target entry (an outgoing
-- invoice + its line items, or an incoming cost); the generator fills in the
-- run-specific fields (date, fresh invoice number) at materialisation time so
-- the snapshot stays date-agnostic. Templating off a snapshot rather than a FK
-- means editing or deleting the source entry never disturbs the schedule.
CREATE TABLE IF NOT EXISTS recurring_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'incoming')),
  label TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count >= 1),
  next_run_date TEXT NOT NULL,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  payload TEXT NOT NULL,
  last_run_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT recurring_company_fk FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recurring_company ON recurring_entries (company_id);
CREATE INDEX IF NOT EXISTS idx_recurring_next_run ON recurring_entries (next_run_date);
