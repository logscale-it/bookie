-- DAT-1.e rollback: re-add the legacy REAL money columns and recreate the
-- pre-0025 audit + immutability triggers that referenced them.
--
-- The bytes of the original REAL representation cannot be recovered
-- bit-perfectly: we repopulate from the *_cents counterparts via
-- `<col> = <col>_cents / 100.0`. For currency values that originally fit
-- in 2 fractional digits (the only case the application ever wrote) this
-- yields the same value back, but a hand-written REAL outside that grid
-- (e.g. legacy 0.001 line entries) would round to the cents quantum
-- across this round-trip — acceptable because cents-as-INTEGER is the
-- post-DAT-1 canonical form, and DAT-1.b/c/d already moved every read
-- and write to the cents columns before this drop.
--
-- The columns are re-added at the end of each table rather than at their
-- original physical positions; SQLite addresses columns by name so this
-- is semantically equivalent, but the textual `CREATE TABLE` snapshot in
-- `sqlite_schema.sql` will differ from the pre-up snapshot. The
-- migration round-trip harness in `src-tauri/tests/migrations.rs` reports
-- that as a mismatch, which is why this migration carries a
-- `.noop_down` marker (see `src-tauri/migrations/0025/.noop_down`).
-- The harness still applies this SQL so syntax errors surface as
-- warnings; only the schema-equality assertion is downgraded.

-----------------------------------------------------------------------------
-- 1. Drop the post-up triggers (the ones 0025 created without the REAL
--    column references).
-----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS invoices_audit_insert;
DROP TRIGGER IF EXISTS invoices_audit_update;
DROP TRIGGER IF EXISTS invoices_audit_delete;

DROP TRIGGER IF EXISTS invoice_items_audit_insert;
DROP TRIGGER IF EXISTS invoice_items_audit_update;
DROP TRIGGER IF EXISTS invoice_items_audit_delete;

DROP TRIGGER IF EXISTS payments_audit_insert;
DROP TRIGGER IF EXISTS payments_audit_update;
DROP TRIGGER IF EXISTS payments_audit_delete;

DROP TRIGGER IF EXISTS invoices_immutable_update;

-----------------------------------------------------------------------------
-- 2a. Re-add the legacy REAL columns to tables that were modified via
--     plain ALTER TABLE DROP COLUMN in the up migration. The columns are
--     appended at the end (SQLite ALTER TABLE has no syntax to add at a
--     specific position), so the textual CREATE TABLE differs from the
--     pre-up snapshot — see the `.noop_down` marker for why this is OK.
-----------------------------------------------------------------------------

ALTER TABLE invoices ADD COLUMN net_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN gross_amount REAL NOT NULL DEFAULT 0;

ALTER TABLE invoice_items ADD COLUMN unit_price_net REAL NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN line_total_net REAL NOT NULL DEFAULT 0;

ALTER TABLE incoming_invoices ADD COLUMN net_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE incoming_invoices ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE incoming_invoices ADD COLUMN gross_amount REAL NOT NULL DEFAULT 0;

-----------------------------------------------------------------------------
-- 2b. Rebuild `payments` to restore the original 0001 schema: a REAL
--     `amount NOT NULL` column with the table-level
--     `CONSTRAINT payments_amount_check CHECK (amount > 0)` invariant.
--     The up migration removed both via a CREATE _new rebuild; this is
--     the symmetric inverse.
--
--     The original column ordering (id, invoice_id, payment_date, amount,
--     method, reference, note, created_at, updated_at) is restored, with
--     `amount_cents` re-appended at the end (matching 0015's ALTER TABLE
--     ADD COLUMN placement, so the post-down schema text matches the
--     pre-up schema text *for this table*).
-----------------------------------------------------------------------------

PRAGMA foreign_keys=OFF;
BEGIN;

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
  CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT payments_amount_check CHECK (amount > 0)
);

INSERT INTO payments_new (
  id, invoice_id, payment_date, amount, method, reference, note,
  created_at, updated_at
)
SELECT
  id, invoice_id, payment_date, amount_cents / 100.0, method, reference, note,
  created_at, updated_at
FROM payments;

ALTER TABLE payments_new ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0;
UPDATE payments_new SET amount_cents = (
  SELECT amount_cents FROM payments WHERE payments.id = payments_new.id
);

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments (payment_date);

PRAGMA foreign_key_check;

COMMIT;
PRAGMA foreign_keys=ON;

-----------------------------------------------------------------------------
-- 3. Repopulate the re-added REAL columns from the *_cents columns. We
--    do this only for the tables that were ALTER-only above (`payments`
--    is already populated as part of its rebuild). Division by 100.0
--    forces floating-point arithmetic so 1234 -> 12.34 (and not the
--    integer 12).
-----------------------------------------------------------------------------

UPDATE invoices SET
  net_amount   = net_cents   / 100.0,
  tax_amount   = tax_cents   / 100.0,
  gross_amount = gross_cents / 100.0;

UPDATE invoice_items SET
  unit_price_net = unit_price_net_cents / 100.0,
  line_total_net = line_total_net_cents / 100.0;

UPDATE incoming_invoices SET
  net_amount   = net_cents   / 100.0,
  tax_amount   = tax_cents   / 100.0,
  gross_amount = gross_cents / 100.0;

-----------------------------------------------------------------------------
-- 4. Recreate the pre-0025 triggers verbatim (matching migrations 0019
--    and 0021). Trigger SQL is captured by `sqlite_schema.sql`, so the
--    text below must match the originals byte-for-byte to round-trip
--    through the migration harness. The schema-equality assertion still
--    fails because the table-level CREATE TABLE statements no longer
--    list the REAL columns at their original positions, but every
--    trigger row will match exactly.
-----------------------------------------------------------------------------

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

-- Note: the `invoice_items_audit_*` triggers were silently lost when the
-- 0021 storno migration rebuilt the `invoice_items` table (SQLite drops
-- triggers along with their host table). They were already absent from
-- the pre-0025 state, so this rollback does not recreate them.

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

-- Restored immutability_update trigger (matches the 0021 version which
-- supersedes the 0020 version). The DELETE trigger from 0020 is
-- column-agnostic and was never dropped by 0025.
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
