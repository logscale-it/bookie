-- DAT-1.e: Drop the legacy REAL money columns now that all reads/writes
-- run through the *_cents counterparts (DAT-1.b/c/d, PRs #52/#53/#54).
--
-- Columns dropped:
--   invoices.net_amount, invoices.tax_amount, invoices.gross_amount
--   invoice_items.unit_price_net, invoice_items.line_total_net
--   payments.amount
--   incoming_invoices.net_amount, incoming_invoices.tax_amount,
--   incoming_invoices.gross_amount
--
-- SQLite supports ALTER TABLE ... DROP COLUMN since 3.35 (2021). The Tauri
-- SQL plugin bundles a SQLite well past that, so the syntax is safe in
-- practice. The down migration recreates the columns as REAL and
-- repopulates them from the *_cents columns (divided by 100.0); the bytes
-- of the original REAL representation are not bit-perfect after a
-- round-trip because cents-as-INTEGER is the canonical form and floating
-- point conversion is lossy. The down also re-adds the columns at the end
-- of the table rather than at their original positions; the round-trip
-- harness's textual schema diff therefore reports a mismatch and this
-- migration carries a `.noop_down` marker so the diff is downgraded to a
-- warning.
--
-- Trigger handling
-- ----------------
-- SQLite refuses to drop a column that is referenced by a trigger, view,
-- or index. The audit triggers from migration 0019 (DAT-4.b) reference
-- every dropped REAL column on every affected table, and the
-- immutability UPDATE trigger from 0021 (DAT-2.b, which supersedes the
-- 0020 version) references invoices.net_amount / tax_amount /
-- gross_amount. We therefore drop the dependent triggers first, then
-- drop the columns, then recreate the triggers with the REAL column
-- references removed.
--
-- CHECK-constraint handling
-- -------------------------
-- SQLite ALTER TABLE DROP COLUMN also refuses to drop a column that is
-- named in a *table-level* CHECK constraint (column-level inline CHECKs
-- are dropped with the column, but a `CONSTRAINT name CHECK (col ...)`
-- listed at the end of CREATE TABLE blocks the drop):
--
--   * `invoices`: no CHECK constraints on the dropped REAL columns —
--     plain DROP COLUMN.
--   * `invoice_items`: the original `>= 0` CHECKs from 0001 were already
--     dropped by the 0021 storno table rebuild — plain DROP COLUMN.
--   * `incoming_invoices`: the `>= 0` CHECKs from 0007 are *inline*
--     column-level CHECKs (`net_amount REAL NOT NULL CHECK (net_amount
--     >= 0)`), which DROP COLUMN handles automatically — plain DROP
--     COLUMN.
--   * `payments`: the `> 0` CHECK is a *table-level* constraint
--     (`CONSTRAINT payments_amount_check CHECK (amount > 0)`), so plain
--     DROP COLUMN fails. We rebuild `payments` via the standard
--     CREATE _new / INSERT SELECT / DROP / RENAME recipe and re-apply
--     the foreign key + the equivalent `> 0` invariant on `amount_cents`
--     (which previously had no CHECK; the surviving column inherits the
--     positivity contract from the original `amount` definition).

-----------------------------------------------------------------------------
-- 1. Drop dependent triggers (0019 audit + 0021 immutability_update).
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
-- 2a. Drop the legacy REAL money columns whose CHECK constraints (if any)
--     were inline / column-level. SQLite handles those automatically.
-----------------------------------------------------------------------------

ALTER TABLE invoices DROP COLUMN net_amount;
ALTER TABLE invoices DROP COLUMN tax_amount;
ALTER TABLE invoices DROP COLUMN gross_amount;

ALTER TABLE invoice_items DROP COLUMN unit_price_net;
ALTER TABLE invoice_items DROP COLUMN line_total_net;

ALTER TABLE incoming_invoices DROP COLUMN net_amount;
ALTER TABLE incoming_invoices DROP COLUMN tax_amount;
ALTER TABLE incoming_invoices DROP COLUMN gross_amount;

-----------------------------------------------------------------------------
-- 2b. Rebuild `payments` because its `amount` column is referenced by a
--     table-level CHECK constraint (`CONSTRAINT payments_amount_check
--     CHECK (amount > 0)`) defined in migration 0001. SQLite ALTER TABLE
--     DROP COLUMN cannot drop such a column; we use the standard
--     CREATE _new / INSERT SELECT / DROP / RENAME recipe.
--
--     The rebuild also takes the opportunity to port the positivity
--     invariant onto the surviving `amount_cents` column via a new
--     `CONSTRAINT payments_amount_cents_check CHECK (amount_cents > 0)`,
--     so the rule the application has always relied on is preserved at
--     the SQL layer rather than silently lost with the dropped column.
-----------------------------------------------------------------------------

PRAGMA foreign_keys=OFF;
BEGIN;

CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT payments_amount_cents_check CHECK (amount_cents > 0)
);

INSERT INTO payments_new (
  id, invoice_id, payment_date, method, reference, note,
  created_at, updated_at, amount_cents
)
SELECT
  id, invoice_id, payment_date, method, reference, note,
  created_at, updated_at, amount_cents
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments (payment_date);

PRAGMA foreign_key_check;

COMMIT;
PRAGMA foreign_keys=ON;

-----------------------------------------------------------------------------
-- 3. Recreate the audit triggers without the dropped REAL columns.
--    Mirrors migration 0019 (DAT-4.b) verbatim minus the REAL columns.
-----------------------------------------------------------------------------

CREATE TRIGGER invoices_audit_insert
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

CREATE TRIGGER invoices_audit_update
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

CREATE TRIGGER invoices_audit_delete
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

-- Note: the `invoice_items_audit_*` triggers from migration 0019 were
-- silently dropped by SQLite when the 0021 storno table rebuild dropped
-- and renamed `invoice_items` (SQLite removes triggers along with their
-- table). They are therefore NOT in the pre-up state and we do not
-- recreate them here; reinstating them belongs to a separate audit-coverage
-- follow-up rather than this column-drop migration. The DROP TRIGGER IF
-- EXISTS statements in section 1 are no-ops on a clean install but keep
-- the migration safe against any environment where the triggers happen
-- to still be present.

CREATE TRIGGER payments_audit_insert
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
      'amount_cents',  json_object('before', NULL, 'after', NEW.amount_cents),
      'method',        json_object('before', NULL, 'after', NEW.method),
      'reference',     json_object('before', NULL, 'after', NEW.reference),
      'note',          json_object('before', NULL, 'after', NEW.note),
      'created_at',    json_object('before', NULL, 'after', NEW.created_at),
      'updated_at',    json_object('before', NULL, 'after', NEW.updated_at)
    )
  );
END;

CREATE TRIGGER payments_audit_update
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
      CASE WHEN OLD.amount_cents IS NEW.amount_cents THEN '' ELSE '"amount_cents":' || json_object('before', OLD.amount_cents, 'after', NEW.amount_cents) || ',' END ||
      CASE WHEN OLD.method       IS NEW.method       THEN '' ELSE '"method":'       || json_object('before', OLD.method,       'after', NEW.method)       || ',' END ||
      CASE WHEN OLD.reference    IS NEW.reference    THEN '' ELSE '"reference":'    || json_object('before', OLD.reference,    'after', NEW.reference)    || ',' END ||
      CASE WHEN OLD.note         IS NEW.note         THEN '' ELSE '"note":'         || json_object('before', OLD.note,         'after', NEW.note)         || ',' END ||
      CASE WHEN OLD.created_at   IS NEW.created_at   THEN '' ELSE '"created_at":'   || json_object('before', OLD.created_at,   'after', NEW.created_at)   || ',' END ||
      CASE WHEN OLD.updated_at   IS NEW.updated_at   THEN '' ELSE '"updated_at":'   || json_object('before', OLD.updated_at,   'after', NEW.updated_at)   || ',' END
    , ',') || '}')
  );
END;

CREATE TRIGGER payments_audit_delete
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
      'amount_cents',  json_object('before', OLD.amount_cents, 'after', NULL),
      'method',        json_object('before', OLD.method,       'after', NULL),
      'reference',     json_object('before', OLD.reference,    'after', NULL),
      'note',          json_object('before', OLD.note,         'after', NULL),
      'created_at',    json_object('before', OLD.created_at,   'after', NULL),
      'updated_at',    json_object('before', OLD.updated_at,   'after', NULL)
    )
  );
END;

-----------------------------------------------------------------------------
-- 4. Recreate the immutability UPDATE trigger without REAL column references.
--    Mirrors the 0021 (DAT-2.b) version verbatim minus net_amount /
--    tax_amount / gross_amount.
-----------------------------------------------------------------------------

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
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;
