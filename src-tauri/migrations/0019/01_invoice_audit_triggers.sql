-- DAT-4.b: AFTER INSERT/UPDATE/DELETE triggers on invoices, invoice_items,
-- payments. Each trigger writes one row to invoice_audit (created in 0017)
-- with fields_diff = {"col": {"before": <old>, "after": <new>}}.
--
-- Strategy
-- --------
-- INSERT: before=NULL, after=NEW.col for every audited column.
-- DELETE: before=OLD.col, after=NULL for every audited column.
-- UPDATE: emit only columns whose value actually changed.
--
-- For INSERT/DELETE we use json_object() directly because nulls only ever
-- appear *inside* the {before, after} value — top-level keys are always the
-- column names, which are non-null strings.
--
-- For UPDATE we cannot use json_patch() to drop unchanged columns, because
-- json_patch follows RFC 7396 (JSON Merge Patch) which strips ANY null
-- recursively, including the legitimate null inside {before: null,
-- after: ...} when only one side of a change is null. We therefore build the
-- object as a string with explicit `||` concatenation, emitting an empty
-- fragment for unchanged columns and a `"col":{"before":...,"after":...},`
-- fragment for changed ones. A final rtrim(...,',') removes the trailing
-- comma and json() validates the result.
--
-- ts_unix_us is microseconds since the Unix epoch (UTC). SQLite's
-- unixepoch('subsec') returns seconds with subsecond precision, so
-- CAST(unixepoch('subsec') * 1000000 AS INTEGER) yields integer microseconds.
--
-- actor is left NULL by these triggers. The application layer is expected
-- to populate it via a separate audit hook in a follow-up step.
--
-- `OLD.x IS NEW.x` is the SQL standard NULL-aware equality, so a column
-- transitioning from NULL to NULL counts as unchanged and is omitted.

-----------------------------------------------------------------------------
-- invoices
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

-----------------------------------------------------------------------------
-- invoice_items
-- entity_id is the parent invoice_id so an auditor can reconstruct the full
-- history of one invoice (line items + the invoice row itself) by filtering
-- invoice_audit on entity_id and entity_type IN ('invoices', 'invoice_items').
-----------------------------------------------------------------------------

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

-----------------------------------------------------------------------------
-- payments
-- entity_id is the parent invoice_id, same rationale as invoice_items.
-----------------------------------------------------------------------------

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
