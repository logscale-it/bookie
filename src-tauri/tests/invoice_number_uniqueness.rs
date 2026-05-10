//! DAT-3.b: Validate that `invoice_number` uniqueness is scoped per company.
//!
//! The constraint changed in migration 0016 from a global
//! `UNIQUE (invoice_number)` to a per-company
//! `UNIQUE (company_id, invoice_number)`.  These tests verify:
//!
//! - Two *different* companies may each hold the same `invoice_number` —
//!   both inserts succeed.
//! - A *same-company* duplicate `invoice_number` is rejected with a UNIQUE
//!   constraint violation.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};

// ---------------------------------------------------------------------------
// Migration replay helpers (mirrors the pattern in tests/migrations.rs)
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
// Helpers to insert the minimal set of FK-required rows
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

/// Insert an invoice with the given company/customer/number; returns the
/// rusqlite result so the caller can assert success or failure.
fn try_insert_invoice(
    conn: &Connection,
    company_id: i64,
    customer_id: i64,
    invoice_number: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO invoices \
         (company_id, customer_id, invoice_number, issue_date, \
          net_amount, tax_amount, gross_amount, \
          net_cents, tax_cents, gross_cents) \
         VALUES (?1, ?2, ?3, '2026-01-01', 0, 0, 0, 0, 0, 0)",
        rusqlite::params![company_id, customer_id, invoice_number],
    )
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

#[test]
fn invoice_number_uniqueness() {
    let conn = open_migrated_db();

    // Set up two companies, each with one customer.
    insert_company(&conn, 1, "Alpha GmbH");
    insert_company(&conn, 2, "Beta GmbH");
    insert_customer(&conn, 1, 1);
    insert_customer(&conn, 2, 2);

    // Company A: first invoice '2026-001' — must succeed.
    try_insert_invoice(&conn, 1, 1, "2026-001")
        .expect("company A, invoice '2026-001' (first insert) must succeed");

    // Company B: same invoice_number '2026-001' — must succeed (different company).
    try_insert_invoice(&conn, 2, 2, "2026-001")
        .expect("company B, invoice '2026-001' must succeed (different company)");

    // Company A: duplicate invoice_number '2026-001' — must fail.
    let err = try_insert_invoice(&conn, 1, 1, "2026-001")
        .expect_err("company A, invoice '2026-001' (second insert) must fail");

    match err {
        rusqlite::Error::SqliteFailure(ref sqlite_err, _)
            if sqlite_err.code == ErrorCode::ConstraintViolation =>
        {
            // Expected: UNIQUE constraint on (company_id, invoice_number) fired.
        }
        other => panic!("expected a UNIQUE constraint error but got: {other:?}"),
    }
}
