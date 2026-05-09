-- Roll back DAT-4.b: drop the audit triggers added in 0019.
-- The invoice_audit table itself is owned by 0017 and is left in place.

DROP TRIGGER IF EXISTS payments_audit_delete;
DROP TRIGGER IF EXISTS payments_audit_update;
DROP TRIGGER IF EXISTS payments_audit_insert;

DROP TRIGGER IF EXISTS invoice_items_audit_delete;
DROP TRIGGER IF EXISTS invoice_items_audit_update;
DROP TRIGGER IF EXISTS invoice_items_audit_insert;

DROP TRIGGER IF EXISTS invoices_audit_delete;
DROP TRIGGER IF EXISTS invoices_audit_update;
DROP TRIGGER IF EXISTS invoices_audit_insert;
