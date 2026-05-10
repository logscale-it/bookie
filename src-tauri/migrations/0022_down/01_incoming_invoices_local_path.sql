-- DAT-5.a rollback: drop the `local_path` column added in 0022/up.
--
-- SQLite supports `DROP COLUMN` since 3.35 (2021). The Tauri SQL plugin
-- ships rusqlite with a bundled SQLite well past that version, so this is
-- safe in practice. The `IF EXISTS` clause keeps the rollback idempotent
-- when partially applied.
ALTER TABLE incoming_invoices DROP COLUMN local_path;
