//! DAT-4.c: Verify the AFTER UPDATE trigger on `invoices` writes exactly one
//! `invoice_audit` row whose `fields_diff` JSON captures the expected
//! before/after values.
//!
//! The audit table is created in migration 0017 (DAT-4.a) and the AFTER
//! INSERT/UPDATE/DELETE triggers on `invoices`, `invoice_items`, and
//! `payments` are added in migration 0019 (DAT-4.b).
//!
//! The UPDATE trigger emits `fields_diff = {col: {before: <old>, after:
//! <new>}}` for every column whose value actually changed (NULL-aware
//! equality via `OLD.x IS NEW.x`). This test inserts a fresh draft invoice,
//! updates only `net_cents`, and asserts:
//!
//! 1. Exactly one `invoice_audit` row is added by the UPDATE (over and above
//!    the INSERT row that the AFTER INSERT trigger already produced).
//! 2. That row carries `entity_type = 'invoices'`, `entity_id =
//!    <invoice id>`, `op = 'update'`, a non-zero `ts_unix_us`, and
//!    `fields_diff` with a single key `net_cents` mapping to the expected
//!    {before, after} pair.
//!
//! Drafts are used so the DAT-2.a immutability triggers (migration 0020) do
//! not fire — those only kick in once `status <> 'draft'`.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Migration replay helpers (mirrors the pattern in
// tests/invoice_number_uniqueness.rs and tests/migrations.rs).
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

/// Build a fresh in-memory SQLite database with every migration applied.
fn open_migrated_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
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

// ---------------------------------------------------------------------------
// FK-required row helpers
// ---------------------------------------------------------------------------

fn insert_company(conn: &Connection, id: i64, name: &str) {
    conn.execute(
        "INSERT INTO companies (id, name, country_code) VALUES (?1, ?2, 'DE')",
        rusqlite::params![id, name],
    )
    .unwrap_or_else(|e| panic!("insert company {id} failed: {e}"));
}

fn insert_customer(conn: &Connection, id: i64, company_id: i64) {
    conn.execute(
        "INSERT INTO customers (id, company_id, name) VALUES (?1, ?2, 'Test Customer')",
        rusqlite::params![id, company_id],
    )
    .unwrap_or_else(|e| panic!("insert customer {id} failed: {e}"));
}

/// Insert a draft invoice with explicit cents columns and return its id.
/// `status` defaults to 'draft' (per migration 0016), and we leave it that
/// way so the immutability trigger on issued invoices does not fire when we
/// later update the row.
fn insert_draft_invoice(
    conn: &Connection,
    company_id: i64,
    customer_id: i64,
    invoice_number: &str,
    net_cents: i64,
    tax_cents: i64,
    gross_cents: i64,
) -> i64 {
    // DAT-1.e (#55, migration 0025): the legacy REAL money columns are
    // dropped, so the INSERT only names the `*_cents` columns.
    conn.execute(
        "INSERT INTO invoices \
         (company_id, customer_id, invoice_number, issue_date, \
          net_cents, tax_cents, gross_cents) \
         VALUES (?1, ?2, ?3, '2026-01-01', ?4, ?5, ?6)",
        rusqlite::params![
            company_id,
            customer_id,
            invoice_number,
            net_cents,
            tax_cents,
            gross_cents
        ],
    )
    .unwrap_or_else(|e| panic!("insert invoice failed: {e}"));
    conn.last_insert_rowid()
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

#[test]
fn invoice_audit_diff() {
    let conn = open_migrated_db();

    // Set up the FK chain.
    insert_company(&conn, 1, "Alpha GmbH");
    insert_customer(&conn, 1, 1);

    // Insert a draft invoice. The AFTER INSERT trigger writes one row to
    // invoice_audit with op='insert'. Capture that baseline so we can isolate
    // the row produced by the UPDATE.
    let invoice_id = insert_draft_invoice(&conn, 1, 1, "2026-001", 10_000, 1_900, 11_900);

    let rows_after_insert: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'invoices' AND entity_id = ?1",
            rusqlite::params![invoice_id],
            |row| row.get(0),
        )
        .expect("count audit rows after insert");
    assert_eq!(
        rows_after_insert, 1,
        "AFTER INSERT trigger should produce exactly one audit row (DAT-4.b precondition)"
    );

    // Mutate exactly one column: net_cents 10_000 -> 12_500.
    let new_net_cents: i64 = 12_500;
    let updated_rows = conn
        .execute(
            "UPDATE invoices SET net_cents = ?1 WHERE id = ?2",
            rusqlite::params![new_net_cents, invoice_id],
        )
        .expect("update net_cents on draft invoice");
    assert_eq!(updated_rows, 1, "UPDATE should affect exactly one row");

    // Assert: exactly one *update* row exists for this invoice.
    let update_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'invoices' AND entity_id = ?1 AND op = 'update'",
            rusqlite::params![invoice_id],
            |row| row.get(0),
        )
        .expect("count update audit rows");
    assert_eq!(
        update_rows, 1,
        "AFTER UPDATE trigger must write exactly one invoice_audit row \
         for a single-column update (got {update_rows})"
    );

    // Total rows for this invoice = 1 insert + 1 update.
    let total_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'invoices' AND entity_id = ?1",
            rusqlite::params![invoice_id],
            |row| row.get(0),
        )
        .expect("count total audit rows");
    assert_eq!(
        total_rows, 2,
        "expected 1 insert + 1 update audit row (got {total_rows})"
    );

    // Inspect the update row's payload.
    let (op, ts_unix_us, fields_diff_json): (String, i64, String) = conn
        .query_row(
            "SELECT op, ts_unix_us, fields_diff FROM invoice_audit \
             WHERE entity_type = 'invoices' AND entity_id = ?1 AND op = 'update'",
            rusqlite::params![invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("fetch update audit row");

    assert_eq!(op, "update");
    assert!(
        ts_unix_us > 0,
        "ts_unix_us must be a positive epoch microsecond value, got {ts_unix_us}"
    );

    let diff: Value = serde_json::from_str(&fields_diff_json)
        .unwrap_or_else(|e| panic!("fields_diff is not valid JSON: {e}\nraw: {fields_diff_json}"));

    let obj = diff
        .as_object()
        .unwrap_or_else(|| panic!("fields_diff must be a JSON object, got: {diff}"));

    // Only the changed column may appear: net_cents. updated_at is NOT
    // auto-bumped by the schema on UPDATE (default applies only on INSERT),
    // so a single-column write should diff to a single-key object.
    assert_eq!(
        obj.len(),
        1,
        "fields_diff should contain exactly one key (the changed column), \
         got {} keys: {:?}",
        obj.len(),
        obj.keys().collect::<Vec<_>>()
    );
    assert!(
        obj.contains_key("net_cents"),
        "fields_diff must contain 'net_cents' key, got: {diff}"
    );

    let entry = &obj["net_cents"];
    let before = entry
        .get("before")
        .unwrap_or_else(|| panic!("net_cents diff missing 'before': {entry}"));
    let after = entry
        .get("after")
        .unwrap_or_else(|| panic!("net_cents diff missing 'after': {entry}"));

    assert_eq!(
        before.as_i64(),
        Some(10_000),
        "before should be original net_cents 10_000, got {before}"
    );
    assert_eq!(
        after.as_i64(),
        Some(new_net_cents),
        "after should be new net_cents {new_net_cents}, got {after}"
    );
}
