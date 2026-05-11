-- DAT-6.a: SQL-side append-only enforcement on `invoice_audit`.
--
-- `docs/compliance/gobd.md` §2.3 documents the audit table as append-only and
-- footnotes that the SQL-side lock is "vorgesehen". Today only application
-- discipline prevents `UPDATE`/`DELETE` on `invoice_audit`; a maintenance
-- script, a future Tauri command, or a misuse of the DB plugin's raw-SQL
-- path could silently overwrite or delete audit rows and break the
-- §2.3 "lückenloses Änderungsprotokoll" claim — which is the entire basis
-- of the GoBD Nachvollziehbarkeit guarantee.
--
-- COMP-1.a (#90) is the retention guard on `invoices`/`payments` paths, not
-- on `invoice_audit` itself, so this gap is real and not covered elsewhere.
--
-- Strategy
-- --------
-- Two `BEFORE` triggers that `RAISE(ABORT, 'audit_immutable')` whenever an
-- UPDATE or DELETE is attempted on any row in `invoice_audit`. INSERT is
-- intentionally NOT blocked — the audit table must keep accepting new rows
-- from the AFTER triggers installed by 0019 (DAT-4.b).
--
-- Naming: `invoice_audit_immutable_<op>` mirrors the convention used by the
-- existing immutability triggers on `invoices` (`invoices_immutable_update`,
-- `invoices_immutable_delete`) and is distinct from the `<table>_audit_<op>`
-- pattern used by the writer triggers in 0019 — so there is no collision.
--
-- Reason string `'audit_immutable'` is intentionally short, lowercase, and
-- snake_case so it is a stable matching token for application-side error
-- handling and for the integration test in DAT-6.c (#197).

CREATE TRIGGER IF NOT EXISTS invoice_audit_immutable_update
BEFORE UPDATE ON invoice_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'audit_immutable');
END;

CREATE TRIGGER IF NOT EXISTS invoice_audit_immutable_delete
BEFORE DELETE ON invoice_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'audit_immutable');
END;
