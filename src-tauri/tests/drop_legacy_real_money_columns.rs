//! DAT-1.e (#55): Verify that migration 0025 removes every legacy REAL money
//! column from the schema.
//!
//! The acceptance criterion from the issue body is:
//!
//!   `PRAGMA table_info(invoices)` does not list
//!   `net_amount`/`tax_amount`/`gross_amount`; same for `invoice_items`,
//!   `payments`, and `incoming_invoices`.
//!
//! This test:
//!
//!   1. Builds a fresh in-memory SQLite database.
//!   2. Applies every up-migration directory under `src-tauri/migrations/`
//!      in numeric order (mirrors the pattern in
//!      `tests/invoice_audit_diff.rs`).
//!   3. Runs `PRAGMA table_info(<table>)` on each affected table and asserts
//!      the dropped REAL columns are absent and the surviving cents columns
//!      are present.
//!
//! It also asserts the audit and immutability triggers were recreated
//! (post-0025 they no longer reference the dropped columns) by inspecting
//! `sqlite_schema`.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Migration replay helpers (mirrors the pattern in
// `tests/invoice_audit_diff.rs` / `tests/migrations.rs`).
// ---------------------------------------------------------------------------

fn migrations_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

fn read_migration_sql(dir: &Path) -> String {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read migration dir {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
        })
        .collect();
    files.sort();

    let mut script = String::new();
    for path in &files {
        let contents = fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read SQL file {}: {e}", path.display()));
        script.push_str(&contents);
        if !script.ends_with('\n') {
            script.push('\n');
        }
    }
    script
}

/// Build a fresh in-memory SQLite database with every up-migration applied
/// in ascending numeric order.
fn open_migrated_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    // 0001/00_pragma.sql also enables foreign keys, but set it here so the
    // baseline is consistent with the production runtime.
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");

    let root = migrations_root();
    let mut dirs: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read migrations dir {}: {e}", root.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !n.ends_with("_down"))
                    .unwrap_or(false)
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.parse::<u32>().ok())
                    .is_some()
        })
        .collect();
    dirs.sort_by_key(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0)
    });

    for dir in &dirs {
        let sql = read_migration_sql(dir);
        let label = dir.file_name().unwrap().to_string_lossy();
        conn.execute_batch(&sql)
            .unwrap_or_else(|e| panic!("apply migration {label}: {e}\n--- SQL ---\n{sql}"));
    }

    conn
}

/// Return the column names from `PRAGMA table_info(<table>)`.
fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn
        .prepare(&sql)
        .unwrap_or_else(|e| panic!("prepare {sql}: {e}"));
    // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk.
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap_or_else(|e| panic!("query {sql}: {e}"));
    rows.collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|e| panic!("collect {sql}: {e}"))
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn invoices_legacy_real_columns_dropped() {
    let conn = open_migrated_db();
    let cols = table_columns(&conn, "invoices");

    for dropped in ["net_amount", "tax_amount", "gross_amount"] {
        assert!(
            !cols.iter().any(|c| c == dropped),
            "PRAGMA table_info(invoices) still lists '{dropped}'; got columns: {cols:?}",
        );
    }

    for kept in ["net_cents", "tax_cents", "gross_cents"] {
        assert!(
            cols.iter().any(|c| c == kept),
            "PRAGMA table_info(invoices) lost the cents column '{kept}'; got: {cols:?}",
        );
    }
}

#[test]
fn invoice_items_legacy_real_columns_dropped() {
    let conn = open_migrated_db();
    let cols = table_columns(&conn, "invoice_items");

    for dropped in ["unit_price_net", "line_total_net"] {
        assert!(
            !cols.iter().any(|c| c == dropped),
            "PRAGMA table_info(invoice_items) still lists '{dropped}'; got columns: {cols:?}",
        );
    }

    for kept in ["unit_price_net_cents", "line_total_net_cents"] {
        assert!(
            cols.iter().any(|c| c == kept),
            "PRAGMA table_info(invoice_items) lost the cents column '{kept}'; got: {cols:?}",
        );
    }
}

#[test]
fn payments_legacy_amount_dropped() {
    let conn = open_migrated_db();
    let cols = table_columns(&conn, "payments");

    assert!(
        !cols.iter().any(|c| c == "amount"),
        "PRAGMA table_info(payments) still lists 'amount'; got columns: {cols:?}",
    );

    assert!(
        cols.iter().any(|c| c == "amount_cents"),
        "PRAGMA table_info(payments) lost 'amount_cents'; got columns: {cols:?}",
    );
}

#[test]
fn incoming_invoices_legacy_real_columns_dropped() {
    let conn = open_migrated_db();
    let cols = table_columns(&conn, "incoming_invoices");

    for dropped in ["net_amount", "tax_amount", "gross_amount"] {
        assert!(
            !cols.iter().any(|c| c == dropped),
            "PRAGMA table_info(incoming_invoices) still lists '{dropped}'; got columns: {cols:?}",
        );
    }

    for kept in ["net_cents", "tax_cents", "gross_cents"] {
        assert!(
            cols.iter().any(|c| c == kept),
            "PRAGMA table_info(incoming_invoices) lost the cents column '{kept}'; got: {cols:?}",
        );
    }
}

/// The `payments_amount_check CHECK (amount > 0)` constraint from migration
/// 0011 is replaced in 0025 by `payments_amount_cents_check CHECK
/// (amount_cents > 0)`. Inserting a row with `amount_cents = 0` must fail.
#[test]
fn payments_cents_check_constraint_active() {
    let conn = open_migrated_db();

    // Seed enough rows to satisfy the FK chain.
    conn.execute(
        "INSERT INTO companies (id, name, country_code) VALUES (1, 'Co', 'DE')",
        [],
    )
    .expect("insert company");
    conn.execute(
        "INSERT INTO customers (id, company_id, name) VALUES (1, 1, 'Cu')",
        [],
    )
    .expect("insert customer");
    conn.execute(
        "INSERT INTO invoices \
         (company_id, customer_id, invoice_number, issue_date, \
          net_cents, tax_cents, gross_cents) \
         VALUES (1, 1, 'INV-CHECK-1', '2026-01-01', 0, 0, 0)",
        [],
    )
    .expect("insert invoice");

    // amount_cents = 0 must be rejected by the new CHECK.
    let err = conn
        .execute(
            "INSERT INTO payments (invoice_id, payment_date, amount_cents) \
             VALUES (1, '2026-01-15', 0)",
            [],
        )
        .expect_err("payments INSERT with amount_cents=0 should fail the CHECK");
    let msg = err.to_string();
    assert!(
        msg.contains("CHECK") || msg.contains("constraint"),
        "expected CHECK constraint failure, got: {msg}",
    );

    // amount_cents = 1 must be accepted.
    conn.execute(
        "INSERT INTO payments (invoice_id, payment_date, amount_cents) \
         VALUES (1, '2026-01-15', 1)",
        [],
    )
    .expect("amount_cents > 0 should pass the CHECK");
}

/// Sanity check: after 0025, the audit and immutability triggers must still
/// exist (they were dropped and recreated in the same migration).
#[test]
fn audit_and_immutability_triggers_recreated() {
    let conn = open_migrated_db();

    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_schema \
             WHERE type = 'trigger' AND name = ?1",
        )
        .expect("prepare trigger lookup");

    for trigger in [
        "invoices_immutable_update",
        "invoices_audit_insert",
        "invoices_audit_update",
        "invoices_audit_delete",
        "invoice_items_audit_insert",
        "invoice_items_audit_update",
        "invoice_items_audit_delete",
        "payments_audit_insert",
        "payments_audit_update",
        "payments_audit_delete",
    ] {
        let found: Option<String> = stmt.query_row([trigger], |row| row.get(0)).ok();
        assert!(
            found.is_some(),
            "trigger '{trigger}' is missing from sqlite_schema after migration 0025",
        );
    }
}
