//! DAT-3.b: Verify invoice_number uniqueness is scoped to (company_id, invoice_number).
//!
//! Two distinct companies must each be able to use the same invoice_number
//! (e.g. both companies issuing invoice "2026-001"), while inserting a
//! duplicate invoice_number for the *same* company must fail with the
//! per-company UNIQUE constraint introduced in migration 0016.
//!
//! This is a deterministic schema test: it loads the relevant migration SQL
//! verbatim from the repository, applies it to an in-memory SQLite database,
//! and exercises the constraint directly.

use rusqlite::{params, Connection, Error as SqlError};

/// All UP migrations from 0001 (initial schema) through 0016 (per-company
/// uniqueness), applied in order. We stop at 0016 because that is where the
/// constraint under test is introduced; later migrations are unrelated.
const MIGRATIONS: &[&str] = &[
    // 0001 — initial accounting schema (mirrors the order in src/lib.rs::app_migrations)
    include_str!("../migrations/0001/00_pragma.sql"),
    include_str!("../migrations/0001/01_companies.sql"),
    include_str!("../migrations/0001/02_customers.sql"),
    include_str!("../migrations/0001/03_projects.sql"),
    include_str!("../migrations/0001/04_invoices.sql"),
    include_str!("../migrations/0001/05_invoice_items.sql"),
    include_str!("../migrations/0001/06_time_entries.sql"),
    include_str!("../migrations/0001/07_payments.sql"),
    include_str!("../migrations/0001/08_invoice_status_history.sql"),
    // 0002..0015 — schema evolution required so that 0016's
    // `INSERT INTO invoices_new SELECT * FROM invoices` line up column-wise.
    include_str!("../migrations/0002/01_settings.sql"),
    include_str!("../migrations/0003/01_customers_website.sql"),
    include_str!("../migrations/0004/01_invoice_delivery_surcharge.sql"),
    include_str!("../migrations/0005/01_org_bank_account_holder.sql"),
    include_str!("../migrations/0006/01_org_address_fields.sql"),
    include_str!("../migrations/0007/01_customer_type_and_incoming_invoices.sql"),
    include_str!("../migrations/0008/01_settings_s3.sql"),
    include_str!("../migrations/0009/01_incoming_invoices_s3_key.sql"),
    include_str!("../migrations/0010/01_s3_auto_backup.sql"),
    include_str!("../migrations/0011/01_payments_restrict_delete.sql"),
    include_str!("../migrations/0012/01_clear_s3_credentials.sql"),
    include_str!("../migrations/0013/01_invoices_s3_key.sql"),
    include_str!("../migrations/0014/01_locale_and_legal.sql"),
    include_str!("../migrations/0015/01_money_cents_columns.sql"),
    // 0016 — the migration under test: replaces the global
    // `invoices_number_unique` constraint with `invoices_number_unique_per_company`.
    include_str!("../migrations/0016/01_invoice_number_per_company.sql"),
];

fn open_migrated_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");
    for sql in MIGRATIONS {
        conn.execute_batch(sql)
            .expect("apply migration SQL successfully");
    }
    conn
}

fn insert_company(conn: &Connection, name: &str) -> i64 {
    conn.execute("INSERT INTO companies (name) VALUES (?1)", params![name])
        .expect("insert company");
    conn.last_insert_rowid()
}

fn insert_customer(conn: &Connection, company_id: i64, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO customers (company_id, name) VALUES (?1, ?2)",
        params![company_id, name],
    )
    .expect("insert customer");
    conn.last_insert_rowid()
}

fn insert_invoice(
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
fn invoice_number_uniqueness_is_per_company() {
    let conn = open_migrated_db();

    // Two separate companies, each with their own customer.
    let company_a = insert_company(&conn, "Company A");
    let company_b = insert_company(&conn, "Company B");
    let customer_a = insert_customer(&conn, company_a, "Customer A");
    let customer_b = insert_customer(&conn, company_b, "Customer B");

    // Both companies are allowed to issue an invoice with the same number.
    insert_invoice(&conn, company_a, customer_a, "2026-001")
        .expect("company A's first invoice with number 2026-001 should succeed");
    insert_invoice(&conn, company_b, customer_b, "2026-001")
        .expect("company B should also be allowed invoice number 2026-001");

    // A duplicate within the same company must be rejected.
    let dup_err = insert_invoice(&conn, company_a, customer_a, "2026-001")
        .expect_err("duplicate invoice_number within company A must fail");

    match dup_err {
        SqlError::SqliteFailure(err, msg) => {
            assert_eq!(
                err.code,
                rusqlite::ErrorCode::ConstraintViolation,
                "expected a UNIQUE constraint violation, got {err:?} ({msg:?})"
            );
            let detail = msg.unwrap_or_default();
            assert!(
                detail.contains("invoices.company_id")
                    && detail.contains("invoices.invoice_number"),
                "constraint violation should reference (company_id, invoice_number); got: {detail}"
            );
        }
        other => panic!("expected SqliteFailure, got {other:?}"),
    }
}
