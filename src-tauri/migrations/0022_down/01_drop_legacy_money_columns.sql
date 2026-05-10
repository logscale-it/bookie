-- Roll back DAT-1.e (#55): re-create the legacy REAL money columns and the
-- triggers that referenced them, restoring the schema to its post-0021 state.
--
-- Strategy is the inverse of the up migration:
--   1. Drop the cents-only triggers from 0022.
--   2. Add the legacy REAL columns back to invoices and invoice_items via
--      ALTER TABLE ADD COLUMN with the same DEFAULT 0 they had in 0001.
--      Backfill from the cents columns (value / 100.0) so a round-trip on
--      a populated DB ends up with the same numeric values it started with.
--   3. Rebuild payments to add `amount` (REAL) plus its CHECK (amount > 0)
--      from migration 0011, backfilling from amount_cents.
--   4. Rebuild incoming_invoices to add net_amount/tax_amount/gross_amount
--      with their CHECK (>= 0) constraints from migration 0007, backfilling
--      from the cents columns.
--   5. Reinstate the immutability trigger from 0021 and the audit triggers
--      from 0019 — i.e. the schema state immediately before 0022 ran.

PRAGMA foreign_keys=OFF;
BEGIN;

-- 1. Drop the cents-only triggers that 0022 created.
DROP TRIGGER IF EXISTS invoices_immutable_update;
DROP TRIGGER IF EXISTS invoices_audit_insert;
DROP TRIGGER IF EXISTS invoices_audit_update;
DROP TRIGGER IF EXISTS invoices_audit_delete;
DROP TRIGGER IF EXISTS invoice_items_audit_insert;
DROP TRIGGER IF EXISTS invoice_items_audit_update;
DROP TRIGGER IF EXISTS invoice_items_audit_delete;
DROP TRIGGER IF EXISTS payments_audit_insert;
DROP TRIGGER IF EXISTS payments_audit_update;
DROP TRIGGER IF EXISTS payments_audit_delete;

-- 2. invoices: add the REAL columns back and backfill.
ALTER TABLE invoices ADD COLUMN net_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN gross_amount REAL NOT NULL DEFAULT 0;
UPDATE invoices SET net_amount = net_cents / 100.0;
UPDATE invoices SET tax_amount = tax_cents / 100.0;
UPDATE invoices SET gross_amount = gross_cents / 100.0;

-- 3. invoice_items: add the REAL columns back and backfill. The original
-- 0001 table had CHECK (>= 0) constraints, but those were intentionally
-- removed in the 0021 storno rebuild; we keep them removed here because
-- the negated storno line items must remain insertable.
ALTER TABLE invoice_items ADD COLUMN unit_price_net REAL NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN line_total_net REAL NOT NULL DEFAULT 0;
UPDATE invoice_items SET unit_price_net = unit_price_net_cents / 100.0;
UPDATE invoice_items SET line_total_net = line_total_net_cents / 100.0;

-- 4. payments: rebuild to bring back `amount` REAL and its CHECK.
CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT,
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT payments_amount_check CHECK (amount > 0)
);

INSERT INTO payments_new (
  id, invoice_id, payment_date, amount, method, reference, note,
  created_at, updated_at, amount_cents
)
SELECT
  id, invoice_id, payment_date, amount_cents / 100.0, method, reference, note,
  created_at, updated_at, amount_cents
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments (payment_date);

-- 5. incoming_invoices: rebuild to bring back the legacy REAL columns and
-- their CHECK (>= 0) constraints from migration 0007.
CREATE TABLE incoming_invoices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  supplier_id INTEGER,
  invoice_number TEXT,
  invoice_date TEXT NOT NULL,
  net_amount REAL NOT NULL CHECK (net_amount >= 0),
  tax_amount REAL NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  gross_amount REAL NOT NULL CHECK (gross_amount >= 0),
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'bezahlt')),
  file_data BLOB,
  file_name TEXT,
  file_type TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  s3_key TEXT,
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  FOREIGN KEY (supplier_id) REFERENCES customers (id) ON DELETE SET NULL
);

INSERT INTO incoming_invoices_new (
  id, company_id, supplier_id, invoice_number, invoice_date,
  net_amount, tax_amount, gross_amount, status,
  file_data, file_name, file_type, notes, created_at, updated_at, s3_key,
  net_cents, tax_cents, gross_cents
)
SELECT
  id, company_id, supplier_id, invoice_number, invoice_date,
  net_cents / 100.0, tax_cents / 100.0, gross_cents / 100.0, status,
  file_data, file_name, file_type, notes, created_at, updated_at, s3_key,
  net_cents, tax_cents, gross_cents
FROM incoming_invoices;

DROP TABLE incoming_invoices;
ALTER TABLE incoming_invoices_new RENAME TO incoming_invoices;

CREATE INDEX IF NOT EXISTS idx_incoming_invoices_company ON incoming_invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_incoming_invoices_supplier ON incoming_invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_incoming_invoices_status ON incoming_invoices (status);
CREATE INDEX IF NOT EXISTS idx_incoming_invoices_date ON incoming_invoices (invoice_date);

PRAGMA foreign_key_check;

-- 6. Reinstate the immutability trigger as it was after 0021 (back-references
-- to legacy money columns included).
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

-- 7. Reinstate audit triggers from 0019, which re-emit the legacy fields.
CREATE TRIGGER IF NOT EXISTS invoices_audit_insert
AFTER INSERT ON invoices
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'invoices',
    NEW.id,
    'insert',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json_object(
      'company_id',                  json_object('before', NULL, 'after', NEW.company_id),
      'customer_id',                 json_object('before', NULL, 'after', NEW.customer_id),
      'project_id',                  json_object('before', NULL, 'after', NEW.project_id),
      'invoice_number',              json_object('before', NULL, 'after', NEW.invoice_number),
      'status',                      json_object('before', NULL, 'after', NEW.status),
      'issue_date',                  json_object('before', NULL, 'after', NEW.issue_date),
      'due_date',                    json_object('before', NULL, 'after', NEW.due_date),
      'service_period_start',        json_object('before', NULL, 'after', NEW.service_period_start),
      'service_period_end',          json_object('before', NULL, 'after', NEW.service_period_end),
      'currency',                    json_object('before', NULL, 'after', NEW.currency),
      'net_amount',                  json_object('before', NULL, 'after', NEW.net_amount),
      'tax_amount',                  json_object('before', NULL, 'after', NEW.tax_amount),
      'gross_amount',                json_object('before', NULL, 'after', NEW.gross_amount),
      'net_cents',                   json_object('before', NULL, 'after', NEW.net_cents),
      'tax_cents',                   json_object('before', NULL, 'after', NEW.tax_cents),
      'gross_cents',                 json_object('before', NULL, 'after', NEW.gross_cents),
      'issuer_name',                 json_object('before', NULL, 'after', NEW.issuer_name),
      'issuer_tax_number',           json_object('before', NULL, 'after', NEW.issuer_tax_number),
      'issuer_vat_id',               json_object('before', NULL, 'after', NEW.issuer_vat_id),
      'issuer_bank_account_holder',  json_object('before', NULL, 'after', NEW.issuer_bank_account_holder),
      'issuer_bank_iban',            json_object('before', NULL, 'after', NEW.issuer_bank_iban),
      'issuer_bank_bic',             json_object('before', NULL, 'after', NEW.issuer_bank_bic),
      'issuer_bank_name',            json_object('before', NULL, 'after', NEW.issuer_bank_name),
      'recipient_name',              json_object('before', NULL, 'after', NEW.recipient_name),
      'recipient_street',            json_object('before', NULL, 'after', NEW.recipient_street),
      'recipient_postal_code',       json_object('before', NULL, 'after', NEW.recipient_postal_code),
      'recipient_city',              json_object('before', NULL, 'after', NEW.recipient_city),
      'recipient_country_code',      json_object('before', NULL, 'after', NEW.recipient_country_code),
      'notes',                       json_object('before', NULL, 'after', NEW.notes),
      'delivery_date',               json_object('before', NULL, 'after', NEW.delivery_date),
      'due_surcharge',               json_object('before', NULL, 'after', NEW.due_surcharge),
      's3_key',                      json_object('before', NULL, 'after', NEW.s3_key),
      'language',                    json_object('before', NULL, 'after', NEW.language),
      'legal_country_code',          json_object('before', NULL, 'after', NEW.legal_country_code),
      'created_at',                  json_object('before', NULL, 'after', NEW.created_at),
      'updated_at',                  json_object('before', NULL, 'after', NEW.updated_at)
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS invoices_audit_update
AFTER UPDATE ON invoices
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'invoices',
    NEW.id,
    'update',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json('{' || rtrim(
      CASE WHEN OLD.company_id                 IS NEW.company_id                 THEN '' ELSE '"company_id":'                 || json_object('before', OLD.company_id,                 'after', NEW.company_id)                 || ',' END ||
      CASE WHEN OLD.customer_id                IS NEW.customer_id                THEN '' ELSE '"customer_id":'                || json_object('before', OLD.customer_id,                'after', NEW.customer_id)                || ',' END ||
      CASE WHEN OLD.project_id                 IS NEW.project_id                 THEN '' ELSE '"project_id":'                 || json_object('before', OLD.project_id,                 'after', NEW.project_id)                 || ',' END ||
      CASE WHEN OLD.invoice_number             IS NEW.invoice_number             THEN '' ELSE '"invoice_number":'             || json_object('before', OLD.invoice_number,             'after', NEW.invoice_number)             || ',' END ||
      CASE WHEN OLD.status                     IS NEW.status                     THEN '' ELSE '"status":'                     || json_object('before', OLD.status,                     'after', NEW.status)                     || ',' END ||
      CASE WHEN OLD.issue_date                 IS NEW.issue_date                 THEN '' ELSE '"issue_date":'                 || json_object('before', OLD.issue_date,                 'after', NEW.issue_date)                 || ',' END ||
      CASE WHEN OLD.due_date                   IS NEW.due_date                   THEN '' ELSE '"due_date":'                   || json_object('before', OLD.due_date,                   'after', NEW.due_date)                   || ',' END ||
      CASE WHEN OLD.service_period_start       IS NEW.service_period_start       THEN '' ELSE '"service_period_start":'       || json_object('before', OLD.service_period_start,       'after', NEW.service_period_start)       || ',' END ||
      CASE WHEN OLD.service_period_end         IS NEW.service_period_end         THEN '' ELSE '"service_period_end":'         || json_object('before', OLD.service_period_end,         'after', NEW.service_period_end)         || ',' END ||
      CASE WHEN OLD.currency                   IS NEW.currency                   THEN '' ELSE '"currency":'                   || json_object('before', OLD.currency,                   'after', NEW.currency)                   || ',' END ||
      CASE WHEN OLD.net_amount                 IS NEW.net_amount                 THEN '' ELSE '"net_amount":'                 || json_object('before', OLD.net_amount,                 'after', NEW.net_amount)                 || ',' END ||
      CASE WHEN OLD.tax_amount                 IS NEW.tax_amount                 THEN '' ELSE '"tax_amount":'                 || json_object('before', OLD.tax_amount,                 'after', NEW.tax_amount)                 || ',' END ||
      CASE WHEN OLD.gross_amount               IS NEW.gross_amount               THEN '' ELSE '"gross_amount":'               || json_object('before', OLD.gross_amount,               'after', NEW.gross_amount)               || ',' END ||
      CASE WHEN OLD.net_cents                  IS NEW.net_cents                  THEN '' ELSE '"net_cents":'                  || json_object('before', OLD.net_cents,                  'after', NEW.net_cents)                  || ',' END ||
      CASE WHEN OLD.tax_cents                  IS NEW.tax_cents                  THEN '' ELSE '"tax_cents":'                  || json_object('before', OLD.tax_cents,                  'after', NEW.tax_cents)                  || ',' END ||
      CASE WHEN OLD.gross_cents                IS NEW.gross_cents                THEN '' ELSE '"gross_cents":'                || json_object('before', OLD.gross_cents,                'after', NEW.gross_cents)                || ',' END ||
      CASE WHEN OLD.issuer_name                IS NEW.issuer_name                THEN '' ELSE '"issuer_name":'                || json_object('before', OLD.issuer_name,                'after', NEW.issuer_name)                || ',' END ||
      CASE WHEN OLD.issuer_tax_number          IS NEW.issuer_tax_number          THEN '' ELSE '"issuer_tax_number":'          || json_object('before', OLD.issuer_tax_number,          'after', NEW.issuer_tax_number)          || ',' END ||
      CASE WHEN OLD.issuer_vat_id              IS NEW.issuer_vat_id              THEN '' ELSE '"issuer_vat_id":'              || json_object('before', OLD.issuer_vat_id,              'after', NEW.issuer_vat_id)              || ',' END ||
      CASE WHEN OLD.issuer_bank_account_holder IS NEW.issuer_bank_account_holder THEN '' ELSE '"issuer_bank_account_holder":' || json_object('before', OLD.issuer_bank_account_holder, 'after', NEW.issuer_bank_account_holder) || ',' END ||
      CASE WHEN OLD.issuer_bank_iban           IS NEW.issuer_bank_iban           THEN '' ELSE '"issuer_bank_iban":'           || json_object('before', OLD.issuer_bank_iban,           'after', NEW.issuer_bank_iban)           || ',' END ||
      CASE WHEN OLD.issuer_bank_bic            IS NEW.issuer_bank_bic            THEN '' ELSE '"issuer_bank_bic":'            || json_object('before', OLD.issuer_bank_bic,            'after', NEW.issuer_bank_bic)            || ',' END ||
      CASE WHEN OLD.issuer_bank_name           IS NEW.issuer_bank_name           THEN '' ELSE '"issuer_bank_name":'           || json_object('before', OLD.issuer_bank_name,           'after', NEW.issuer_bank_name)           || ',' END ||
      CASE WHEN OLD.recipient_name             IS NEW.recipient_name             THEN '' ELSE '"recipient_name":'             || json_object('before', OLD.recipient_name,             'after', NEW.recipient_name)             || ',' END ||
      CASE WHEN OLD.recipient_street           IS NEW.recipient_street           THEN '' ELSE '"recipient_street":'           || json_object('before', OLD.recipient_street,           'after', NEW.recipient_street)           || ',' END ||
      CASE WHEN OLD.recipient_postal_code      IS NEW.recipient_postal_code      THEN '' ELSE '"recipient_postal_code":'      || json_object('before', OLD.recipient_postal_code,      'after', NEW.recipient_postal_code)      || ',' END ||
      CASE WHEN OLD.recipient_city             IS NEW.recipient_city             THEN '' ELSE '"recipient_city":'             || json_object('before', OLD.recipient_city,             'after', NEW.recipient_city)             || ',' END ||
      CASE WHEN OLD.recipient_country_code     IS NEW.recipient_country_code     THEN '' ELSE '"recipient_country_code":'     || json_object('before', OLD.recipient_country_code,     'after', NEW.recipient_country_code)     || ',' END ||
      CASE WHEN OLD.notes                      IS NEW.notes                      THEN '' ELSE '"notes":'                      || json_object('before', OLD.notes,                      'after', NEW.notes)                      || ',' END ||
      CASE WHEN OLD.delivery_date              IS NEW.delivery_date              THEN '' ELSE '"delivery_date":'              || json_object('before', OLD.delivery_date,              'after', NEW.delivery_date)              || ',' END ||
      CASE WHEN OLD.due_surcharge              IS NEW.due_surcharge              THEN '' ELSE '"due_surcharge":'              || json_object('before', OLD.due_surcharge,              'after', NEW.due_surcharge)              || ',' END ||
      CASE WHEN OLD.s3_key                     IS NEW.s3_key                     THEN '' ELSE '"s3_key":'                     || json_object('before', OLD.s3_key,                     'after', NEW.s3_key)                     || ',' END ||
      CASE WHEN OLD.language                   IS NEW.language                   THEN '' ELSE '"language":'                   || json_object('before', OLD.language,                   'after', NEW.language)                   || ',' END ||
      CASE WHEN OLD.legal_country_code         IS NEW.legal_country_code         THEN '' ELSE '"legal_country_code":'         || json_object('before', OLD.legal_country_code,         'after', NEW.legal_country_code)         || ',' END ||
      CASE WHEN OLD.created_at                 IS NEW.created_at                 THEN '' ELSE '"created_at":'                 || json_object('before', OLD.created_at,                 'after', NEW.created_at)                 || ',' END ||
      CASE WHEN OLD.updated_at                 IS NEW.updated_at                 THEN '' ELSE '"updated_at":'                 || json_object('before', OLD.updated_at,                 'after', NEW.updated_at)                 || ',' END
    , ',') || '}')
  );
END;

CREATE TRIGGER IF NOT EXISTS invoices_audit_delete
AFTER DELETE ON invoices
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'invoices',
    OLD.id,
    'delete',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json_object(
      'company_id',                  json_object('before', OLD.company_id,                 'after', NULL),
      'customer_id',                 json_object('before', OLD.customer_id,                'after', NULL),
      'project_id',                  json_object('before', OLD.project_id,                 'after', NULL),
      'invoice_number',              json_object('before', OLD.invoice_number,             'after', NULL),
      'status',                      json_object('before', OLD.status,                     'after', NULL),
      'issue_date',                  json_object('before', OLD.issue_date,                 'after', NULL),
      'due_date',                    json_object('before', OLD.due_date,                   'after', NULL),
      'service_period_start',        json_object('before', OLD.service_period_start,       'after', NULL),
      'service_period_end',          json_object('before', OLD.service_period_end,         'after', NULL),
      'currency',                    json_object('before', OLD.currency,                   'after', NULL),
      'net_amount',                  json_object('before', OLD.net_amount,                 'after', NULL),
      'tax_amount',                  json_object('before', OLD.tax_amount,                 'after', NULL),
      'gross_amount',                json_object('before', OLD.gross_amount,               'after', NULL),
      'net_cents',                   json_object('before', OLD.net_cents,                  'after', NULL),
      'tax_cents',                   json_object('before', OLD.tax_cents,                  'after', NULL),
      'gross_cents',                 json_object('before', OLD.gross_cents,                'after', NULL),
      'issuer_name',                 json_object('before', OLD.issuer_name,                'after', NULL),
      'issuer_tax_number',           json_object('before', OLD.issuer_tax_number,          'after', NULL),
      'issuer_vat_id',               json_object('before', OLD.issuer_vat_id,              'after', NULL),
      'issuer_bank_account_holder',  json_object('before', OLD.issuer_bank_account_holder, 'after', NULL),
      'issuer_bank_iban',            json_object('before', OLD.issuer_bank_iban,           'after', NULL),
      'issuer_bank_bic',             json_object('before', OLD.issuer_bank_bic,            'after', NULL),
      'issuer_bank_name',            json_object('before', OLD.issuer_bank_name,           'after', NULL),
      'recipient_name',              json_object('before', OLD.recipient_name,             'after', NULL),
      'recipient_street',            json_object('before', OLD.recipient_street,           'after', NULL),
      'recipient_postal_code',       json_object('before', OLD.recipient_postal_code,      'after', NULL),
      'recipient_city',              json_object('before', OLD.recipient_city,             'after', NULL),
      'recipient_country_code',      json_object('before', OLD.recipient_country_code,     'after', NULL),
      'notes',                       json_object('before', OLD.notes,                      'after', NULL),
      'delivery_date',               json_object('before', OLD.delivery_date,              'after', NULL),
      'due_surcharge',               json_object('before', OLD.due_surcharge,              'after', NULL),
      's3_key',                      json_object('before', OLD.s3_key,                     'after', NULL),
      'language',                    json_object('before', OLD.language,                   'after', NULL),
      'legal_country_code',          json_object('before', OLD.legal_country_code,         'after', NULL),
      'created_at',                  json_object('before', OLD.created_at,                 'after', NULL),
      'updated_at',                  json_object('before', OLD.updated_at,                 'after', NULL)
    )
  );
END;

-- invoice_items audit triggers (legacy form, with REAL columns) ------------
CREATE TRIGGER IF NOT EXISTS invoice_items_audit_insert
AFTER INSERT ON invoice_items
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'invoice_items',
    NEW.invoice_id,
    'insert',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json_object(
      'id',                    json_object('before', NULL, 'after', NEW.id),
      'invoice_id',            json_object('before', NULL, 'after', NEW.invoice_id),
      'project_id',            json_object('before', NULL, 'after', NEW.project_id),
      'time_entry_id',         json_object('before', NULL, 'after', NEW.time_entry_id),
      'position',              json_object('before', NULL, 'after', NEW.position),
      'description',           json_object('before', NULL, 'after', NEW.description),
      'quantity',              json_object('before', NULL, 'after', NEW.quantity),
      'unit',                  json_object('before', NULL, 'after', NEW.unit),
      'unit_price_net',        json_object('before', NULL, 'after', NEW.unit_price_net),
      'tax_rate',              json_object('before', NULL, 'after', NEW.tax_rate),
      'line_total_net',        json_object('before', NULL, 'after', NEW.line_total_net),
      'unit_price_net_cents',  json_object('before', NULL, 'after', NEW.unit_price_net_cents),
      'line_total_net_cents',  json_object('before', NULL, 'after', NEW.line_total_net_cents),
      'created_at',            json_object('before', NULL, 'after', NEW.created_at),
      'updated_at',            json_object('before', NULL, 'after', NEW.updated_at)
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS invoice_items_audit_update
AFTER UPDATE ON invoice_items
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'invoice_items',
    NEW.invoice_id,
    'update',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json('{' || rtrim(
      CASE WHEN OLD.id                   IS NEW.id                   THEN '' ELSE '"id":'                   || json_object('before', OLD.id,                   'after', NEW.id)                   || ',' END ||
      CASE WHEN OLD.invoice_id           IS NEW.invoice_id           THEN '' ELSE '"invoice_id":'           || json_object('before', OLD.invoice_id,           'after', NEW.invoice_id)           || ',' END ||
      CASE WHEN OLD.project_id           IS NEW.project_id           THEN '' ELSE '"project_id":'           || json_object('before', OLD.project_id,           'after', NEW.project_id)           || ',' END ||
      CASE WHEN OLD.time_entry_id        IS NEW.time_entry_id        THEN '' ELSE '"time_entry_id":'        || json_object('before', OLD.time_entry_id,        'after', NEW.time_entry_id)        || ',' END ||
      CASE WHEN OLD.position             IS NEW.position             THEN '' ELSE '"position":'             || json_object('before', OLD.position,             'after', NEW.position)             || ',' END ||
      CASE WHEN OLD.description          IS NEW.description          THEN '' ELSE '"description":'          || json_object('before', OLD.description,          'after', NEW.description)          || ',' END ||
      CASE WHEN OLD.quantity             IS NEW.quantity             THEN '' ELSE '"quantity":'             || json_object('before', OLD.quantity,             'after', NEW.quantity)             || ',' END ||
      CASE WHEN OLD.unit                 IS NEW.unit                 THEN '' ELSE '"unit":'                 || json_object('before', OLD.unit,                 'after', NEW.unit)                 || ',' END ||
      CASE WHEN OLD.unit_price_net       IS NEW.unit_price_net       THEN '' ELSE '"unit_price_net":'       || json_object('before', OLD.unit_price_net,       'after', NEW.unit_price_net)       || ',' END ||
      CASE WHEN OLD.tax_rate             IS NEW.tax_rate             THEN '' ELSE '"tax_rate":'             || json_object('before', OLD.tax_rate,             'after', NEW.tax_rate)             || ',' END ||
      CASE WHEN OLD.line_total_net       IS NEW.line_total_net       THEN '' ELSE '"line_total_net":'       || json_object('before', OLD.line_total_net,       'after', NEW.line_total_net)       || ',' END ||
      CASE WHEN OLD.unit_price_net_cents IS NEW.unit_price_net_cents THEN '' ELSE '"unit_price_net_cents":' || json_object('before', OLD.unit_price_net_cents, 'after', NEW.unit_price_net_cents) || ',' END ||
      CASE WHEN OLD.line_total_net_cents IS NEW.line_total_net_cents THEN '' ELSE '"line_total_net_cents":' || json_object('before', OLD.line_total_net_cents, 'after', NEW.line_total_net_cents) || ',' END ||
      CASE WHEN OLD.created_at           IS NEW.created_at           THEN '' ELSE '"created_at":'           || json_object('before', OLD.created_at,           'after', NEW.created_at)           || ',' END ||
      CASE WHEN OLD.updated_at           IS NEW.updated_at           THEN '' ELSE '"updated_at":'           || json_object('before', OLD.updated_at,           'after', NEW.updated_at)           || ',' END
    , ',') || '}')
  );
END;

CREATE TRIGGER IF NOT EXISTS invoice_items_audit_delete
AFTER DELETE ON invoice_items
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'invoice_items',
    OLD.invoice_id,
    'delete',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json_object(
      'id',                    json_object('before', OLD.id,                   'after', NULL),
      'invoice_id',            json_object('before', OLD.invoice_id,           'after', NULL),
      'project_id',            json_object('before', OLD.project_id,           'after', NULL),
      'time_entry_id',         json_object('before', OLD.time_entry_id,        'after', NULL),
      'position',              json_object('before', OLD.position,             'after', NULL),
      'description',           json_object('before', OLD.description,          'after', NULL),
      'quantity',              json_object('before', OLD.quantity,             'after', NULL),
      'unit',                  json_object('before', OLD.unit,                 'after', NULL),
      'unit_price_net',        json_object('before', OLD.unit_price_net,       'after', NULL),
      'tax_rate',              json_object('before', OLD.tax_rate,             'after', NULL),
      'line_total_net',        json_object('before', OLD.line_total_net,       'after', NULL),
      'unit_price_net_cents',  json_object('before', OLD.unit_price_net_cents, 'after', NULL),
      'line_total_net_cents',  json_object('before', OLD.line_total_net_cents, 'after', NULL),
      'created_at',            json_object('before', OLD.created_at,           'after', NULL),
      'updated_at',            json_object('before', OLD.updated_at,           'after', NULL)
    )
  );
END;

-- payments audit triggers (legacy form, with REAL amount) ------------------
CREATE TRIGGER IF NOT EXISTS payments_audit_insert
AFTER INSERT ON payments
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'payments',
    NEW.invoice_id,
    'insert',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json_object(
      'id',            json_object('before', NULL, 'after', NEW.id),
      'invoice_id',    json_object('before', NULL, 'after', NEW.invoice_id),
      'payment_date',  json_object('before', NULL, 'after', NEW.payment_date),
      'amount',        json_object('before', NULL, 'after', NEW.amount),
      'amount_cents',  json_object('before', NULL, 'after', NEW.amount_cents),
      'method',        json_object('before', NULL, 'after', NEW.method),
      'reference',     json_object('before', NULL, 'after', NEW.reference),
      'note',          json_object('before', NULL, 'after', NEW.note),
      'created_at',    json_object('before', NULL, 'after', NEW.created_at),
      'updated_at',    json_object('before', NULL, 'after', NEW.updated_at)
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS payments_audit_update
AFTER UPDATE ON payments
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'payments',
    NEW.invoice_id,
    'update',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json('{' || rtrim(
      CASE WHEN OLD.id           IS NEW.id           THEN '' ELSE '"id":'           || json_object('before', OLD.id,           'after', NEW.id)           || ',' END ||
      CASE WHEN OLD.invoice_id   IS NEW.invoice_id   THEN '' ELSE '"invoice_id":'   || json_object('before', OLD.invoice_id,   'after', NEW.invoice_id)   || ',' END ||
      CASE WHEN OLD.payment_date IS NEW.payment_date THEN '' ELSE '"payment_date":' || json_object('before', OLD.payment_date, 'after', NEW.payment_date) || ',' END ||
      CASE WHEN OLD.amount       IS NEW.amount       THEN '' ELSE '"amount":'       || json_object('before', OLD.amount,       'after', NEW.amount)       || ',' END ||
      CASE WHEN OLD.amount_cents IS NEW.amount_cents THEN '' ELSE '"amount_cents":' || json_object('before', OLD.amount_cents, 'after', NEW.amount_cents) || ',' END ||
      CASE WHEN OLD.method       IS NEW.method       THEN '' ELSE '"method":'       || json_object('before', OLD.method,       'after', NEW.method)       || ',' END ||
      CASE WHEN OLD.reference    IS NEW.reference    THEN '' ELSE '"reference":'    || json_object('before', OLD.reference,    'after', NEW.reference)    || ',' END ||
      CASE WHEN OLD.note         IS NEW.note         THEN '' ELSE '"note":'         || json_object('before', OLD.note,         'after', NEW.note)         || ',' END ||
      CASE WHEN OLD.created_at   IS NEW.created_at   THEN '' ELSE '"created_at":'   || json_object('before', OLD.created_at,   'after', NEW.created_at)   || ',' END ||
      CASE WHEN OLD.updated_at   IS NEW.updated_at   THEN '' ELSE '"updated_at":'   || json_object('before', OLD.updated_at,   'after', NEW.updated_at)   || ',' END
    , ',') || '}')
  );
END;

CREATE TRIGGER IF NOT EXISTS payments_audit_delete
AFTER DELETE ON payments
FOR EACH ROW
BEGIN
  INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
  VALUES (
    'payments',
    OLD.invoice_id,
    'delete',
    CAST(unixepoch('subsec') * 1000000 AS INTEGER),
    json_object(
      'id',            json_object('before', OLD.id,           'after', NULL),
      'invoice_id',    json_object('before', OLD.invoice_id,   'after', NULL),
      'payment_date',  json_object('before', OLD.payment_date, 'after', NULL),
      'amount',        json_object('before', OLD.amount,       'after', NULL),
      'amount_cents',  json_object('before', OLD.amount_cents, 'after', NULL),
      'method',        json_object('before', OLD.method,       'after', NULL),
      'reference',     json_object('before', OLD.reference,    'after', NULL),
      'note',          json_object('before', OLD.note,         'after', NULL),
      'created_at',    json_object('before', OLD.created_at,   'after', NULL),
      'updated_at',    json_object('before', OLD.updated_at,   'after', NULL)
    )
  );
END;

COMMIT;
PRAGMA foreign_keys=ON;
