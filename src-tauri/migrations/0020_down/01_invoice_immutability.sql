-- Down migration for DAT-2.a: drop the invoice immutability triggers.
DROP TRIGGER IF EXISTS invoices_immutable_update;
DROP TRIGGER IF EXISTS invoices_immutable_delete;
