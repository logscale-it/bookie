-- Roll back DAT-6.a: drop the append-only enforcement triggers installed on
-- `invoice_audit` by 0026/01_invoice_audit_immutable.sql.
--
-- The `invoice_audit` table itself is owned by 0017 (DAT-4.a) and the writer
-- triggers that populate it are owned by 0019 (DAT-4.b); both are left in
-- place. Only the two immutability triggers added in 0026 are dropped here,
-- restoring the pre-0026 state where `UPDATE`/`DELETE` on `invoice_audit`
-- are syntactically permitted (application discipline remains the only
-- guard, as before DAT-6.a).

DROP TRIGGER IF EXISTS invoice_audit_immutable_update;
DROP TRIGGER IF EXISTS invoice_audit_immutable_delete;
