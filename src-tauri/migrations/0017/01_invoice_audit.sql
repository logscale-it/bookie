-- Polymorphic audit trail table for GoBD compliance.
-- entity_type / entity_id are intentionally generic so this table can log
-- mutations on invoices, invoice_items, and payments from a single set of
-- triggers (DAT-4.b) without requiring separate audit tables per entity.

CREATE TABLE invoice_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL,
  entity_id   INTEGER NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  actor       TEXT,
  ts_unix_us  INTEGER NOT NULL,
  fields_diff TEXT    NOT NULL -- JSON {field: {before, after}}
);

CREATE INDEX invoice_audit_entity_idx ON invoice_audit (entity_type, entity_id);
CREATE INDEX invoice_audit_ts_idx     ON invoice_audit (ts_unix_us);
