-- Reverse migration 0018 (DAT-2.a, #57): drop the GoBD immutability triggers.

DROP TRIGGER IF EXISTS invoices_no_delete_when_issued;
DROP TRIGGER IF EXISTS invoices_no_update_when_issued;
