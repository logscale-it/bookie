# 0026_down — placeholder

This directory exists so the migration round-trip harness in
`src-tauri/tests/migrations.rs` can locate the `_down` sibling of `0026/`
(the harness asserts the directory is present).

The actual rollback SQL (`01_invoice_audit_immutable.sql` containing
`DROP TRIGGER IF EXISTS invoice_audit_immutable_delete;` and
`DROP TRIGGER IF EXISTS invoice_audit_immutable_update;`) is delivered by
DAT-6.b (#196), which will also remove this README and the `.noop_down`
marker in `0026/`.
