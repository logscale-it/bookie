//! DAT-3.b — Per-company `invoice_number` uniqueness.
//!
//! DAT-3.a (PR #126, migration `0016/`) replaced the global
//! `invoices_number_unique UNIQUE (invoice_number)` constraint with a per-
//! company `invoices_number_unique_per_company UNIQUE (company_id,
//! invoice_number)`. This integration test pins down the resulting
//! behaviour against a fresh in-memory SQLite database that has every
//! production migration in `src-tauri/migrations/NNNN/` applied:
//!
//! 1. Company A inserts an invoice with `invoice_number = '2026-001'`. Succeeds.
//! 2. Company B inserts an invoice with the same `invoice_number = '2026-001'`.
//!    Succeeds — the two companies share the number space.
//! 3. Company A inserts a second invoice with `invoice_number = '2026-001'`.
//!    Fails with a `UNIQUE constraint failed: invoices.company_id,
//!    invoices.invoice_number` error (the rusqlite extended code
//!    `SQLITE_CONSTRAINT_UNIQUE` = 2067).
//!
//! The test loads the migrations from disk relative to `CARGO_MANIFEST_DIR`
//! (the same convention used by `migration_round_trip.rs`) so it stays
//! aligned with the runtime `concat!(include_str!(...))` blocks in
//! `src-tauri/src/lib.rs` without re-listing every file.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, ErrorCode};

fn migrations_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

/// Collect every `NNNN/` up-migration directory under `src-tauri/migrations/`
/// in numeric order. `_down/` directories are skipped — this test only needs
/// the cumulative forward state.
fn discover_up_migrations() -> Vec<PathBuf> {
    let root = migrations_dir();
    let mut dirs: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", root.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.ends_with("_down"))
                .unwrap_or(false)
        })
        .collect();
    dirs.sort();
    dirs
}

/// Concatenate every `*.sql` file inside `dir` in name order, mirroring how
/// `tauri-plugin-sql` runs the `concat!(include_str!(...))` blocks at app
/// startup.
fn collect_sql(dir: &Path) -> String {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("sql"))
        .collect();
    files.sort();

    let mut out = String::new();
    for f in files {
        let body = fs::read_to_string(&f).unwrap_or_else(|e| panic!("read {}: {e}", f.display()));
        out.push_str(&body);
        if !body.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// Build a fresh in-memory database with every up-migration applied.
fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    for dir in discover_up_migrations() {
        let sql = collect_sql(&dir);
        conn.execute_batch(&sql)
            .unwrap_or_else(|e| panic!("apply migration {}: {e}", dir.display()));
    }
    conn
}

/// Insert a company and return its `id`.
fn insert_company(conn: &Connection, name: &str) -> i64 {
    conn.execute("INSERT INTO companies (name) VALUES (?1)", params![name])
        .unwrap_or_else(|e| panic!("insert company {name}: {e}"));
    conn.last_insert_rowid()
}

/// Insert a customer for `company_id` and return its `id`. Customers are an
/// FK target on `invoices.customer_id` (NOT NULL), so each company needs its
/// own customer before it can own an invoice.
fn insert_customer(conn: &Connection, company_id: i64, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO customers (company_id, name) VALUES (?1, ?2)",
        params![company_id, name],
    )
    .unwrap_or_else(|e| panic!("insert customer {name} for company {company_id}: {e}"));
    conn.last_insert_rowid()
}

/// Attempt to insert an invoice. Returns the rusqlite `Result` so the caller
/// can assert success or pattern-match on the constraint failure.
fn try_insert_invoice(
    conn: &Connection,
    company_id: i64,
    customer_id: i64,
    invoice_number: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO invoices (company_id, customer_id, invoice_number, issue_date) \
         VALUES (?1, ?2, ?3, '2026-01-01')",
        params![company_id, customer_id, invoice_number],
    )
}

#[test]
fn two_companies_share_invoice_number_same_company_duplicate_rejected() {
    let conn = fresh_db();

    let company_a = insert_company(&conn, "Alpha GmbH");
    let company_b = insert_company(&conn, "Beta GmbH");
    let customer_a = insert_customer(&conn, company_a, "Alpha Kunde");
    let customer_b = insert_customer(&conn, company_b, "Beta Kunde");

    // Case 1: company A claims '2026-001'. Must succeed.
    try_insert_invoice(&conn, company_a, customer_a, "2026-001")
        .expect("first invoice for company A with number 2026-001 should insert");

    // Case 2: company B reuses '2026-001'. Must succeed under the per-company
    // unique constraint introduced by migration 0016 (DAT-3.a).
    try_insert_invoice(&conn, company_b, customer_b, "2026-001").expect(
        "company B should be able to reuse invoice_number 2026-001 \
         (per-(company_id, invoice_number) uniqueness)",
    );

    // Case 3: company A tries '2026-001' a second time. Must fail with the
    // SQLite UNIQUE constraint error.
    let err = try_insert_invoice(&conn, company_a, customer_a, "2026-001")
        .expect_err("duplicate invoice_number within the same company must fail");

    let sqlite_err = err
        .sqlite_error()
        .expect("error must carry an underlying sqlite extended code");
    assert_eq!(
        sqlite_err.code,
        ErrorCode::ConstraintViolation,
        "expected ConstraintViolation, got {:?} ({})",
        sqlite_err.code,
        err
    );

    // Sanity check the message names the per-company constraint columns so
    // we catch a future regression that downgrades the constraint back to
    // global uniqueness.
    let msg = err.to_string();
    assert!(
        msg.contains("invoices.company_id") && msg.contains("invoices.invoice_number"),
        "expected UNIQUE error to mention the (company_id, invoice_number) pair, got: {msg}"
    );

    // And confirm the row state: company A has exactly one '2026-001',
    // company B has exactly one '2026-001'.
    let count_a: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE company_id = ?1 AND invoice_number = '2026-001'",
            params![company_a],
            |r| r.get(0),
        )
        .expect("count company A");
    let count_b: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE company_id = ?1 AND invoice_number = '2026-001'",
            params![company_b],
            |r| r.get(0),
        )
        .expect("count company B");
    assert_eq!(count_a, 1, "company A should have exactly one 2026-001 row");
    assert_eq!(count_b, 1, "company B should have exactly one 2026-001 row");
}
